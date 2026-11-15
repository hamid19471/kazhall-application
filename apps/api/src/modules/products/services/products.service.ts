import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Not, Repository } from 'typeorm';

import { CreateProductDto } from '../dto/create-product.dto';
import { UpdateProductDto } from '../dto/update-product.dto';
import { UpsertVariantDto } from '../dto/upsert-variant.dto';
import { QueryProductsDto, ProductSort } from '../dto/query-products.dto';
import {
  AdminStockState,
  LOW_STOCK_THRESHOLD,
  QueryAdminProductsDto,
} from '../dto/query-admin-products.dto';
import {
  AdjustVariantStockDto,
  StockAdjustModeDto,
} from '../dto/adjust-stock.dto';
import { CreateVariantDto } from '../dto/create-variant.dto';
import { Product } from '../entities/product.entity';
import {
  assertProductCode,
  assertVariantBelongsToProduct,
  assertVariantCode,
  productCodeConflictOr,
  reprefixVariantCode,
} from 'src/common/catalogue/product-codes';
import {
  ProductCodeErrorCodes,
  ProductCodeMessages,
} from 'src/common/constants/product-code.messages';
import { productVisibleOnSiteSql } from 'src/common/catalogue/product-visibility';
import { ProductCodeService } from './product-code.service';
import { ProductVisibilityService } from './product-visibility.service';
import { ProductVariant } from '../entities/product-variant.entity';
import { ProductAttributeValue } from '../entities/product-attribute-value.entity';
import { ProductImage } from '../entities/product-image.entity';
import { Category } from 'src/modules/categories/entities/category.entity';
import { User } from 'src/modules/user/entities/user.entity';
import { ObjectStorageService } from 'src/common/storage/object-storage.service';
import { ObjectDeletionService } from 'src/common/storage/object-deletion.service';
import { ObjectDeletionOrigin } from 'src/common/entities/object-deletion-job.entity';
import {
  InitialStockErrorCodes,
  InitialStockMessages,
} from 'src/common/constants/initial-stock.messages';
import { parsePurchaseCost } from 'src/modules/inventory/valuation/purchase-cost';
import {
  CostingErrorCodes,
  costingError,
} from 'src/modules/inventory/valuation/costing.errors';
import { PRODUCT_IMAGE_MAX_BYTES } from 'src/common/storage/storage.module';
import { verifyProductImageUpload } from 'src/common/storage/product-image-upload.validation';
import {
  CacheService,
  CatalogCacheService,
  CATALOG_NAMESPACES,
  catalogKeys,
} from 'src/database/cache.service';
import { AttributeMessages } from 'src/common/constants/attribute.message';
import { ProductMessages } from 'src/common/constants/product.messages';
import { CategoryMessages } from 'src/common/constants/categories.messages';
import { InventoryService } from 'src/modules/inventory/inventory.service';
import type {
  AdjustStockResult,
  IInventoryService,
} from 'src/modules/inventory/inventory.types';
import {
  AdminProductListItemView,
  AdminProductView,
  AvailabilityView,
  PaginatedResult,
  PublicProductListItemView,
  PublicProductView,
  toAdminProductListItemView,
  toAdminProductView,
  toPublicProductListItemView,
  toPublicProductView,
} from '../views/product.view';
import { assertPermissionsHeld } from 'src/modules/auth/permissions/assert-permission';
import { AuditActor, AuditService } from 'src/modules/audit/audit.service';
import { AuditAction, AuditTarget } from 'src/modules/audit/audit.actions';
import { RealtimeGateway } from 'src/modules/realtime/realtime.gateway';
import { productSellableOnlineSql } from 'src/modules/inventory/availability.projection';
import type { AvailabilityReason } from 'src/modules/realtime/realtime.gateway';

/**
 * Cached catalog documents hold the STATIC product shape only.
 *
 * A 10-minute detail TTL is safe precisely because stock is not in the
 * document (see `CatalogCacheService`). Availability is resolved per request
 * and merged in afterwards, so a cache hit can never serve a stale stock
 * number -- there is no stock number in the cache to be stale.
 */
const PRODUCT_DETAIL_TTL_SECONDS = 600;

/**
 * The list page DOES carry an `inStock` boolean, because filtering and sorting
 * happen in SQL and re-deriving the flag per row per request would defeat the
 * point of caching a page at all. It is therefore given its own deliberately
 * short TTL, and `CatalogCacheService.invalidateVariantAvailability` bumps the
 * namespace version so a sale retires every page immediately. The flag is
 * still only indicative; the authoritative check is at basket/checkout/POS.
 */
const PRODUCT_LIST_TTL_SECONDS = 60;

/** Cheapest ACTIVE variant price, falling back to the product base price. */
const EFFECTIVE_PRICE_SQL = `COALESCE(
  (SELECT MIN(epv."price") FROM "product_variants" epv
    WHERE epv."productId" = p."id" AND epv."isActive" = true),
  p."basePrice"
)`;

/**
 * Dearest ACTIVE variant price, same fallback as EFFECTIVE_PRICE_SQL.
 *
 * Paired with `effectivePrice` (the cheapest) this is what lets a listing card
 * decide whether to print a single price or a "from" price. `variantCount > 1`
 * is NOT that signal: two variants at the same price are one price, and saying
 * "from" there invents a range the shop does not offer.
 */
const MAX_EFFECTIVE_PRICE_SQL = `COALESCE(
  (SELECT MAX(xpv."price") FROM "product_variants" xpv
    WHERE xpv."productId" = p."id" AND xpv."isActive" = true),
  p."basePrice"
)`;

/**
 * The PUBLIC listing's "is any variant buyable?" predicate.
 *
 * It used to be `isv."isActive" = true AND isv."stock" > 0` — physical stock
 * only, reservation-blind. A product whose every unit was held in other
 * customers' baskets therefore advertised itself as available on the listing
 * and revealed itself as sold out the moment the customer opened the detail
 * page, because the detail page subtracts reservations. Two answers for one
 * row, in the same second.
 *
 * It now comes from the same rule as every other availability answer in the
 * application; see `inventory/availability.projection.ts`. `:availabilityAt`
 * must be bound by every query that uses it.
 */
const IN_STOCK_SQL = productSellableOnlineSql(':availabilityAt');

/** Bound to `:availabilityAt` wherever {@link IN_STOCK_SQL} appears. */
const availabilityAt = () => new Date();

const ACTIVE_VARIANT_COUNT_SQL = `(
  SELECT COUNT(*) FROM "product_variants" vcv
   WHERE vcv."productId" = p."id" AND vcv."isActive" = true
)`;

/** EVERY variant, retired ones included. Admin-only: the public list counts
 * only what a customer could buy, which is a different number. */
const TOTAL_VARIANT_COUNT_SQL = `(
  SELECT COUNT(*) FROM "product_variants" tvc
   WHERE tvc."productId" = p."id"
)`;

/**
 * Physical stock over ACTIVE variants.
 *
 * Retired variants are excluded on purpose: their units are not offerable, so
 * counting them would show a discontinued product as well stocked and hide it
 * from the out-of-stock filter — exactly the product an admin is looking for.
 */
const ACTIVE_STOCK_TOTAL_SQL = `COALESCE((
  SELECT SUM(asv."stock") FROM "product_variants" asv
   WHERE asv."productId" = p."id" AND asv."isActive" = true
), 0)`;

/**
 * Reservation-aware availability, evaluated by the SAME statement that
 * paginates.
 *
 * The arithmetic mirrors `InventoryService.computeAvailability` exactly —
 * `availableForBasket = stock - basketReserved - orderAllocated` and
 * `availableForPos = stock - orderAllocated`, over reservations that are
 * `status = 'active'` AND not yet expired. An expired row still sits in the
 * table until the sweeper retires it, so omitting the `expiresAt` predicate
 * would hold stock that nobody is actually holding.
 *
 * "Some active variant has units left" rather than a sum over the product: a
 * product is orderable if ANY of its SKUs is, and summing would let a
 * well-stocked black shirt make the sold-out white one look available.
 */
const buildHasAvailableStockSql = (kindFilter: string) => `EXISTS (
  SELECT 1 FROM "product_variants" avs
   WHERE avs."productId" = p."id"
     AND avs."isActive" = true
     AND avs."stock" - COALESCE((
           SELECT SUM(r."quantity") FROM "stock_reservations" r
            WHERE r."variantId" = avs."id"
              AND r."status" = 'active'
              AND r."expiresAt" > now()${kindFilter}
         ), 0) > 0
)`;

const HAS_WEB_AVAILABLE_STOCK_SQL = buildHasAvailableStockSql('');
const HAS_POS_AVAILABLE_STOCK_SQL = buildHasAvailableStockSql(
  `\n              AND r."kind" = 'order'`,
);

/**
 * SKU stem for a DEFAULT variant the system creates on the admin's behalf.
 *
 * MUST match the shape migration 0012 backfills (`DEFAULT-P<productId>`, with a
 * `-<n>` collision suffix): 0012's `down()` identifies the rows it created by
 * this pattern, and an app-created default is the same kind of row.
 * `product_variants.sku` carries a GLOBAL unique constraint, not a per-product
 * one, so the candidate is probed rather than assumed.
 */
const DEFAULT_VARIANT_SKU_PREFIX = 'DEFAULT-P';

/** How many `-1`, `-2`, ... suffixes to try before giving up on a SKU. */
const DEFAULT_VARIANT_SKU_MAX_ATTEMPTS = 50;

interface ListRow {
  id: number | string;
  effective_price: number | string | null;
  max_effective_price: number | string | null;
  in_stock: boolean;
  variant_count: number | string;
}

interface AdminListRow {
  id: number | string;
  effective_price: number | string | null;
  max_effective_price: number | string | null;
  variant_count: number | string;
  active_variant_count: number | string;
  total_stock: number | string;
  has_web_available_stock: boolean;
  has_pos_available_stock: boolean;
}

/** One planned variant-code rewrite, computed before anything is written. */
interface VariantCodeRename {
  variantId: number;
  previousCode: string;
  nextCode: string;
}

export interface AdjustVariantStockResponse extends AdjustStockResult {
  productId: number;
  sku: string;
}

/** What `applyVariantContract` did, so the caller can audit it honestly. */
interface VariantContractOutcome {
  touchedVariantIds: number[];
  activationChanges: Array<{ id: number; sku: string; isActive: boolean }>;
}

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(ProductVariant)
    private readonly productVariantRepository: Repository<ProductVariant>,
    @InjectRepository(ProductAttributeValue)
    private readonly productAttributeValueRepository: Repository<ProductAttributeValue>,
    @InjectRepository(ProductImage)
    private readonly productImageRepository: Repository<ProductImage>,
    private readonly storage: ObjectStorageService,
    /**
     * Durable deletion. Handed a key INSIDE the transaction that destroys the
     * row holding it, so a failed `DeleteObject` is a retry rather than a
     * permanently forgotten object — see `ObjectDeletionService`.
     */
    private readonly objectDeletion: ObjectDeletionService,
    /**
     * The validated upload ceiling, in bytes. Injected rather than read from
     * `ConfigService` here so there is exactly one place that decides what an
     * unset or malformed `PRODUCT_IMAGE_MAX_BYTES` means -- `StorageModule`,
     * at boot, where a bad value stops the process instead of silently
     * becoming a default nobody wrote.
     */
    @Inject(PRODUCT_IMAGE_MAX_BYTES)
    private readonly productImageMaxBytes: number,
    private readonly cacheService: CacheService,
    private readonly catalogCache: CatalogCacheService,
    private readonly productCodes: ProductCodeService,
    private readonly visibility: ProductVisibilityService,
    private readonly dataSource: DataSource,
    /**
     * The catalog depends on the shared CONTRACT, not on the implementation:
     * the declared type is `IInventoryService` (owned by the lead, in
     * `inventory.types.ts`) and only the DI token is the concrete class. That
     * keeps `getAvailability` / `adjustStock` swappable -- the integration
     * harness substitutes a reference implementation of the same interface --
     * and it is what lets stock live behind one authority instead of the
     * catalog growing its own copy of the reservation arithmetic.
     */
    @Inject(InventoryService)
    private readonly inventoryService: IInventoryService,
    private readonly audit: AuditService,
    /**
     * Announcing a committed catalogue change. NEVER called from inside a
     * transaction -- see `publishAvailability` and the call sites in
     * `adjustVariantStock` / `update`.
     */
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  /**
   * Broadcast `availability:updated` for variants whose SELLABILITY may have
   * changed, reading the committed truth back from the database.
   *
   * ## Why it re-reads rather than trusting the caller
   *
   * The payload's `inStock: false` is documented as AUTHORITATIVE -- a client
   * is entitled to believe nothing can be sold -- so it may only ever be
   * derived from committed state. This runs after the transaction closes and
   * reads `product_variants` directly, which is exactly that.
   *
   * ## Why `isActive` is part of the answer
   *
   * A retired SKU with fifty units in the stockroom is not sellable. Reporting
   * `inStock: true` for it because the number is positive would be true about
   * the warehouse and false about the shop, and the shop is what this event is
   * for.
   *
   * ## Why a failure here is swallowed
   *
   * The stock movement / product edit is already committed. Realtime is
   * advisory by contract -- every client re-reads `GET /cart`,
   * `GET /products/:id` or `GET /inventory/availability` before acting, and the
   * polling fallback covers a dropped frame. Turning a broadcast failure into a
   * 500 would fail a request whose work succeeded.
   */
  private async publishAvailability(
    variantIds: number[],
    reason: AvailabilityReason = 'catalogue',
  ): Promise<void> {
    /*
     * `catalogue` by default: this is the variant-contract path, so what
     * changed is whether a SKU exists and whether it is retired — not how many
     * units are on the shelf. A newly created variant carrying opening stock is
     * the exception, and passes `'stock'`.
     *
     * The variant re-read and the `isActive && stock > 0` derivation that used
     * to live here are gone. That expression was one of the five competing
     * definitions of `inStock`; the frame no longer carries state, so there is
     * nothing left to derive.
     */
    await this.realtimeGateway.publishAvailabilityInvalidation(
      variantIds,
      reason,
    );
  }

  // =========================================================================
  // CREATE
  // =========================================================================

  /**
   * Runs in one transaction: an unknown attribute value, a duplicate SKU or a
   * stolen image id leaves no half-created product behind.
   *
   * UNIFORM SELLABLE-SKU MODEL (migration 0012). A product created WITHOUT
   * variants is a "simple" product, and it gets exactly one DEFAULT variant in
   * this same transaction. `product_variants` is the only sellable unit in the
   * system: a product with no variant row used to be sellable anyway through a
   * `variantId === null` branch in `CartService` that skipped the variant lock,
   * the availability check and the four-hour reservation entirely. Creating the
   * default here is what stops that hole being re-opened one product at a time.
   *
   * The default starts at STOCK 0 -- and there is deliberately no way to pass an
   * opening stock for it. Stock enters the system only through
   * `POST /products/variants/:variantId/stock/adjust`, which takes the variant
   * row lock and writes a `stock_movements` row with a `balanceAfter`, so the
   * very first count is auditable like every later one.
   */
  async create(
    createProductDto: CreateProductDto,
    actor: AuditActor,
    /**
     * The caller's effective capability codes. Needed here and not only on the
     * route because `initialStock` carries its OWN authorisation requirement
     * (`inventory.adjust`) that depends on the VALUE, not just on the endpoint
     * — a decorator cannot express "only when the number is above zero".
     */
    actorPermissions: readonly string[] = [],
    options: { isSuperAdmin?: boolean } = {},
  ): Promise<AdminProductView> {
    const {
      categoryIds,
      variants,
      images,
      initialStock,
      productCode: rawProductCode,
      visibleOnSite,
      branchVisibility,
      branchIds,
      purchasePrice: rawPurchasePrice,
      ...productDto
    } = createProductDto;

    /*
     * ======================================================================
     * THE OPENING QUANTITY, DECIDED BEFORE THE TRANSACTION OPENS
     * ======================================================================
     * Both refusals below are about the request itself, so neither needs a
     * database round trip and neither should reach a transaction it would
     * only roll back.
     */
    const wantsInitialStock = initialStock !== undefined;
    const isSimpleProduct = !variants?.length;

    if (wantsInitialStock && !isSimpleProduct) {
      /*
       * Refused rather than applied to one of the variants or silently
       * dropped. With explicit variants there is no single quantity to mean —
       * each carries its own `stock` — and guessing which one the caller
       * intended would put units on the wrong SKU, which is exactly the class
       * of error a ledger exists to make impossible.
       */
      throw new BadRequestException({
        error: InitialStockErrorCodes.INITIAL_STOCK_WITH_VARIANTS,
        message: InitialStockMessages.WITH_VARIANTS,
        field: 'initialStock',
      });
    }

    const openingQuantity = Math.trunc(initialStock ?? 0);

    /*
     * ======================================================================
     * PURCHASE COST, DECIDED BEFORE THE TRANSACTION OPENS
     * (docs/PURCHASE-COST-ACCOUNTING.md §6)
     * ======================================================================
     * Parsed here so a malformed figure is a 400 with a stable code before
     * any row exists. `undefined` means "not given" and is NEVER read as 0.
     */
    const simpleCost = parsePurchaseCost(rawPurchasePrice, 'purchasePrice');
    const variantCosts = new Map<CreateVariantDto, bigint | undefined>();
    (variants ?? []).forEach((variant, index) => {
      variantCosts.set(
        variant,
        parsePurchaseCost(
          variant.purchasePrice,
          `variants[${index}].purchasePrice`,
        ),
      );
    });

    if (rawPurchasePrice !== undefined && !isSimpleProduct) {
      // Same reasoning as INITIAL_STOCK_WITH_VARIANTS: a product-level cost
      // cannot be silently spread across variants that may cost differently.
      throw costingError.badRequest(CostingErrorCodes.PURCHASE_COST_INVALID, {
        field: 'purchasePrice',
        detail: 'Give each variant its own variants[].purchasePrice.',
      });
    }

    const sendsCost =
      simpleCost !== undefined ||
      [...variantCosts.values()].some((cost) => cost !== undefined);
    if (sendsCost && options.isSuperAdmin !== true) {
      // Cost is super_admin-only BY ROLE (owner decision B-2), exactly like
      // the reports: no capability code can grant it.
      throw costingError.forbidden(CostingErrorCodes.PURCHASE_COST_FORBIDDEN, {
        field: 'purchasePrice',
      });
    }

    if (isSimpleProduct && openingQuantity > 0 && simpleCost === undefined) {
      throw costingError.badRequest(
        CostingErrorCodes.INITIAL_STOCK_REQUIRES_PURCHASE_COST,
        { field: 'purchasePrice' },
      );
    }
    (variants ?? []).forEach((variant, index) => {
      if ((variant.stock ?? 0) > 0 && variantCosts.get(variant) === undefined) {
        throw costingError.badRequest(
          CostingErrorCodes.INITIAL_STOCK_REQUIRES_PURCHASE_COST,
          { field: `variants[${index}].purchasePrice` },
        );
      }
    });

    if (openingQuantity > 0 && !actorPermissions.includes('inventory.adjust')) {
      /*
       * ENFORCED IN THE SERVICE, not on the route. The route cannot express
       * this: `products.create` is its floor, and whether `inventory.adjust`
       * is additionally required depends on a number in the body. A delegated
       * catalogue editor may still create the product — with zero — so the
       * refusal names the workaround rather than dead-ending them.
       */
      throw new ForbiddenException({
        error: InitialStockErrorCodes.INITIAL_STOCK_REQUIRES_INVENTORY_ADJUST,
        message: InitialStockMessages.REQUIRES_INVENTORY_ADJUST,
        field: 'initialStock',
      });
    }

    /*
     * Codes are normalised BEFORE the transaction opens. `assertProductCode`
     * throws a 400 naming the field, and doing it here means a malformed code
     * never reaches a transaction it would only roll back.
     */
    const productCode = assertProductCode(rawProductCode);
    const variantCodes = this.normaliseVariantCodes(variants, productCode);

    let savedId: number;
    try {
      savedId = await this.dataSource.transaction(async (manager) => {
        /*
         * VISIBILITY IS RESOLVED FIRST, inside the transaction but before any
         * write. `resolve` both validates the branch ids and enforces the
         * super_admin rule, so an unauthorised publish is refused before a
         * product row exists rather than after one has to be rolled back.
         *
         * Omitting the fields entirely yields HIDDEN/DRAFT, which is what a
         * delegated catalogue editor gets: they may create, and only a
         * super_admin may publish.
         */
        const visibility = await this.visibility.resolve(
          manager,
          {
            visibleOnSite: visibleOnSite ?? false,
            branchVisibility: branchVisibility ?? 'none',
            branchIds: branchIds ?? [],
          },
          {
            isSuperAdmin: options.isSuperAdmin === true,
            current: null,
          },
        );

        const product = manager
          .getRepository(Product)
          .create({ ...productDto, productCode });

        if (categoryIds?.length) {
          product.categories = await this.resolveCategories(
            manager,
            categoryIds,
          );
        }

        if (variants?.length) {
          const built: ProductVariant[] = [];
          for (const variant of variants) {
            built.push(
              manager.getRepository(ProductVariant).create({
                price: variant.price ?? 0,
                // ALWAYS 0 on the INSERT. Opening units arrive below as a
                // valued `initial_stock` movement — the INSERT used to carry
                // them directly, with no ledger row and no cost.
                stock: 0,
                sku: variant.sku,
                variantCode: variantCodes.get(variant)!,
                isActive: true,
                attributeValues: await this.resolveAttributeValues(
                  manager,
                  variant.attributeValueIds,
                ),
              }),
            );
          }
          this.assertNoDuplicateSkus(built.map((v) => v.sku));
          product.variants = built;
        }

        const saved = await manager.getRepository(Product).save(product);

        const variantIds = (saved.variants ?? []).map((v) => v.id);

        /*
         * EACH VARIANT'S OPENING BALANCE, VALUED, IN THIS TRANSACTION. `built`
         * and `saved.variants` are the same objects in the same order, so the
         * DTO each variant came from is found by position. A failure rolls
         * back the product, every variant, categories, images and visibility.
         */
        if (variants?.length) {
          for (let i = 0; i < variants.length; i++) {
            const dto = variants[i];
            const row = saved.variants[i];
            const cost = variantCosts.get(dto);
            const quantity = Math.trunc(dto.stock ?? 0);
            if (quantity > 0) {
              await this.inventoryService.recordInitialStock(manager, {
                variantId: row.id,
                quantity,
                unitCost: cost!,
                actorUserId: actor.userId,
                actorDisplaySnapshot: actor.display,
              });
            } else if (cost !== undefined) {
              await this.inventoryService.rememberPurchaseCost(
                manager,
                row.id,
                cost,
              );
            }
          }
        }
        if (!variants?.length) {
          const defaultVariantId = await this.createDefaultVariant(
            manager,
            saved.id,
            productDto,
            productCode,
          );
          variantIds.push(defaultVariantId);

          /*
           * THE OPENING BALANCE, AS A LEDGER MOVEMENT — in this transaction.
           *
           * Not `stock: openingQuantity` on the INSERT above. That shortcut
           * would produce units with NO evidence: the physical count would
           * say ten and `stock_movements` would say nothing ever arrived, so
           * every later reconciliation would be off by the opening balance
           * and the ledger would stop being the thing that explains the
           * number.
           *
           * ZERO WRITES NOTHING. A zero-delta row would be a ledger entry
           * recording that nothing happened, and `delta` is documented as
           * never zero. A product created empty is simply out of stock, which
           * is already representable without inventing a movement for it.
           *
           * A failure here rolls back the product, its variant, its
           * categories, its images and its visibility along with the
           * movement — they are one transaction, so a product cannot exist
           * with stock the ledger cannot account for.
           */
          if (openingQuantity > 0) {
            await this.inventoryService.recordInitialStock(manager, {
              variantId: defaultVariantId,
              quantity: openingQuantity,
              // Checked above: a positive opening quantity has a cost.
              unitCost: simpleCost!,
              actorUserId: actor.userId,
              actorDisplaySnapshot: actor.display,
            });
          } else if (simpleCost !== undefined) {
            // Zero stock: remembered for the next receipt, nothing valued.
            await this.inventoryService.rememberPurchaseCost(
              manager,
              defaultVariantId,
              simpleCost,
            );
          }
        }

        // After the product row exists, so the foreign key resolves. The
        // deferrable trigger checks the mode/rows pair at COMMIT, not here.
        await this.visibility.persist(manager, saved.id, visibility);

        if (images?.length) {
          await this.applyImageContract(manager, saved.id, images);
        }

        // Inside the transaction, so the trail commits with the product.
        // The summary is an EXPLICIT ALLOW-LIST, never the DTO: the DTO is a
        // request body, and a body is exactly the shape that acquires a new
        // field nobody re-reviewed before it lands in an append-only table.
        await this.audit.record(
          {
            actor,
            action: AuditAction.PRODUCT_CREATED,
            targetType: AuditTarget.PRODUCT,
            targetId: saved.id,
            targetLabel: saved.title,
            summary: {
              after: {
                title: saved.title,
                basePrice: saved.basePrice ?? null,
                categoryIds: [...new Set(categoryIds ?? [])],
                variantIds,
              },
            },
          },
          manager,
        );

        return saved.id;
      });
    } catch (err) {
      throw this.translatePersistenceError(err);
    }

    await this.catalogCache.invalidateProducts([savedId]);

    /*
     * A NEW product's variants may be born carrying opening stock
     * (`variants[].stock`), which is a real availability change that this path
     * announced to nobody — the invariant "stock only enters through the
     * ledgered adjust endpoint" is asserted in the DTO docs but is not
     * enforced here, so the frame has to exist.
     *
     * `stock` rather than `catalogue`: if units arrived, the till's sellable
     * number moved too. A product created with every variant at zero publishes
     * nothing, because nothing became sellable.
     */
    const bornWithStock = await this.dataSource
      .query<Array<{ id: number | string }>>(
        `SELECT "id" FROM "product_variants"
          WHERE "productId" = $1 AND "isActive" = true AND "stock" > 0`,
        [savedId],
      )
      .catch(() => [] as Array<{ id: number | string }>);
    if (bornWithStock.length > 0) {
      await this.publishAvailability(
        bornWithStock.map((row) => Number(row.id)),
        'stock',
      );
    }

    return this.findOneAdmin(savedId);
  }

  // =========================================================================
  // READ
  // =========================================================================

  /**
   * Paginated, filtered, sorted catalog list.
   *
   * Two-phase on purpose: phase 1 resolves the page of ids plus the SQL-side
   * aggregates (effective price, in-stock, active variant count) so no variant
   * rows are hydrated; phase 2 loads only the light relations the list card
   * needs. The old implementation joined categories + variants + images for
   * EVERY product in the catalog and cached the whole blob.
   */
  async findAll(
    query: QueryProductsDto = new QueryProductsDto(),
  ): Promise<PaginatedResult<PublicProductListItemView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const sort = query.sort ?? ProductSort.NEWEST;

    if (
      query.minPrice !== undefined &&
      query.maxPrice !== undefined &&
      query.minPrice > query.maxPrice
    ) {
      throw new BadRequestException('minPrice cannot exceed maxPrice');
    }

    const version = await this.cacheService.getVersion(
      CATALOG_NAMESPACES.PRODUCTS,
    );
    const cacheKey = catalogKeys.productList(
      version,
      this.buildListCacheDiscriminator(query, page, limit, sort),
    );

    return this.cacheService.getOrSet(
      cacheKey,
      PRODUCT_LIST_TTL_SECONDS,
      async () => {
        const filtered = this.buildFilteredQuery(query);
        const total = await filtered.getCount();
        const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

        if (total === 0 || (page - 1) * limit >= total) {
          return { data: [], total, page, limit, totalPages };
        }

        const rowsQb = this.buildFilteredQuery(query)
          .select('p.id', 'id')
          .addSelect(EFFECTIVE_PRICE_SQL, 'effective_price')
          .addSelect(MAX_EFFECTIVE_PRICE_SQL, 'max_effective_price')
          .addSelect(IN_STOCK_SQL, 'in_stock')
          .setParameter('availabilityAt', availabilityAt())
          .addSelect(ACTIVE_VARIANT_COUNT_SQL, 'variant_count')
          .offset((page - 1) * limit)
          .limit(limit);

        this.applySort(rowsQb, sort);

        const rows: ListRow[] = await rowsQb.getRawMany();
        const ids = rows.map((r) => Number(r.id));

        const products = await this.productRepository.find({
          where: { id: In(ids) },
          // Deliberately NOT loading variants, users or cartItems.
          relations: { categories: true, images: true },
        });
        const byId = new Map(products.map((p) => [p.id, p]));

        const data = rows
          .map((row) => {
            const product = byId.get(Number(row.id));
            if (!product) return null;
            return toPublicProductListItemView(product, {
              effectivePrice:
                row.effective_price === null
                  ? null
                  : Number(row.effective_price),
              maxEffectivePrice:
                row.max_effective_price === null
                  ? null
                  : Number(row.max_effective_price),
              inStock: Boolean(row.in_stock),
              variantCount: Number(row.variant_count),
            });
          })
          .filter((v): v is PublicProductListItemView => v !== null);

        return { data, total, page, limit, totalPages };
      },
    );
  }

  /**
   * ADMIN catalogue list.
   *
   * NOT THE PUBLIC LIST WITH A FLAG. `findAll` is cached, counts only active
   * variants and hides everything an admin came here to see; reusing it would
   * mean either leaking stock integers into a cached storefront document or
   * building the admin screen out of numbers that exclude exactly the retired
   * variants it is meant to surface.
   *
   * DELIBERATELY UNCACHED. This is the screen an admin opens straight after a
   * stock adjustment, a variant retirement or a price edit; a cached page — at
   * ANY TTL — shows them their own write missing and invites them to do it
   * twice. The public list can be stale because a customer cannot tell; an
   * administrator can, and acts on it.
   *
   * Two phases, like the public list: one aggregate query resolves the page of
   * ids together with every count, price and availability flag (no variant rows
   * are hydrated), then one relation load fetches the categories and images the
   * row needs. Never N+1.
   */
  async findAllAdmin(
    query: QueryAdminProductsDto,
  ): Promise<PaginatedResult<AdminProductListItemView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const total = await this.buildAdminFilteredQuery(query).getCount();
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    if (total === 0 || (page - 1) * limit >= total) {
      return { data: [], total, page, limit, totalPages };
    }

    const rows: AdminListRow[] = await this.buildAdminFilteredQuery(query)
      .select('p.id', 'id')
      .addSelect(EFFECTIVE_PRICE_SQL, 'effective_price')
      .addSelect(MAX_EFFECTIVE_PRICE_SQL, 'max_effective_price')
      .addSelect(TOTAL_VARIANT_COUNT_SQL, 'variant_count')
      .addSelect(ACTIVE_VARIANT_COUNT_SQL, 'active_variant_count')
      .addSelect(ACTIVE_STOCK_TOTAL_SQL, 'total_stock')
      .addSelect(HAS_WEB_AVAILABLE_STOCK_SQL, 'has_web_available_stock')
      .addSelect(HAS_POS_AVAILABLE_STOCK_SQL, 'has_pos_available_stock')
      // `id DESC` is the tiebreaker, not decoration: `created_at` is a
      // timestamp and a bulk import gives many products the same one, which
      // without it would shuffle rows between pages and hide some entirely.
      .orderBy('p.created_at', 'DESC')
      .addOrderBy('p.id', 'DESC')
      .offset((page - 1) * limit)
      .limit(limit)
      .getRawMany();

    const ids = rows.map((r) => Number(r.id));
    const products = await this.productRepository.find({
      where: { id: In(ids) },
      // Deliberately NOT loading variants, users or cartItems -- every variant
      // fact this row needs was aggregated in SQL above.
      relations: { categories: true, images: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    const data = rows
      .map((row) => {
        const product = byId.get(Number(row.id));
        if (!product) return null;
        return toAdminProductListItemView(product, {
          variantCount: Number(row.variant_count),
          activeVariantCount: Number(row.active_variant_count),
          totalStock: Number(row.total_stock),
          effectivePrice:
            row.effective_price === null ? null : Number(row.effective_price),
          maxEffectivePrice:
            row.max_effective_price === null
              ? null
              : Number(row.max_effective_price),
          hasWebAvailableStock: Boolean(row.has_web_available_stock),
          hasPosAvailableStock: Boolean(row.has_pos_available_stock),
        });
      })
      .filter((v): v is AdminProductListItemView => v !== null);

    return { data, total, page, limit, totalPages };
  }

  /**
   * Entity-level accessor for other server-side modules (cart, orders).
   *
   * NOT cached and NOT exposed by a controller. It deliberately never loads
   * `cartItems` or `users`: those are other customers' private rows, and the
   * previous implementation both returned and cached them under a global key.
   */
  async findOne(id: number): Promise<Product> {
    const product = await this.productRepository.findOne({
      where: { id },
      relations: {
        categories: true,
        /*
         * `attribute` is LOAD-BEARING for the storefront, not extra detail.
         * `PublicVariantView.attributeValues[].attribute` carries the axis NAME
         * (رنگ, سایز, ظرفیت). Without it the product page receives bare values
         * -- "مدیوم", "مشکی", "گورتکس" -- with no way to tell which axis each
         * belongs to, so it renders NO variant picker at all and a multi-variant
         * product can be added to the basket with no variant chosen.
         * `findOneAdmin` has always loaded it; the public path simply did not.
         */
        variants: { attributeValues: { attribute: true } },
        images: true,
      },
    });
    if (!product)
      throw new NotFoundException(ProductMessages.PRODUCT_NOT_FOUND);
    return product;
  }

  /** Public storefront detail. Cached static document + fresh availability. */
  async findOnePublic(id: number): Promise<PublicProductView> {
    /*
     * THE WEBSITE CHANNEL GATE, checked BEFORE the cache is consulted.
     *
     * 404, not 403: a product withdrawn from the site must be indistinguishable
     * from one that never existed, or the detail route becomes an oracle for
     * enumerating the private catalogue — the same reasoning that makes
     * `isMissingOrForbidden` fold 403 and 404 together on the client.
     *
     * It reads the authoritative row rather than the cached document because
     * the cached document has no visibility field in it: the public projection
     * deliberately never carries one, so there is nothing in the cache to
     * check. The read is a single indexed lookup.
     */
    const visible: unknown[] = await this.productRepository.query(
      `SELECT 1 FROM "products" WHERE "id" = $1 AND "visibleOnSite" = true LIMIT 1`,
      [id],
    );
    if (visible.length === 0) {
      throw new NotFoundException(ProductMessages.PRODUCT_NOT_FOUND);
    }

    const version = await this.cacheService.getVersion(
      CATALOG_NAMESPACES.PRODUCTS,
    );

    const document = await this.cacheService.getOrSet(
      catalogKeys.productDetail(version, id),
      PRODUCT_DETAIL_TTL_SECONDS,
      async () => toPublicProductView(await this.findOne(id)),
    );

    const availability = await this.resolveAvailability(
      document.variants.map((v) => v.id),
    );

    return {
      ...document,
      variants: document.variants.map((v) => ({
        ...v,
        ...(availability.has(v.id)
          ? { availability: availability.get(v.id) }
          : {}),
      })),
    };
  }

  /** Admin detail. Never cached (it carries stock and inactive variants). */
  /**
   * Admin detail — the ONLY projection that carries the visibility
   * configuration. Neither the public views nor the POS views expose it.
   */
  async findOneAdmin(id: number): Promise<AdminProductView> {
    const product = await this.productRepository.findOne({
      where: { id },
      relations: {
        categories: true,
        variants: { attributeValues: { attribute: true } },
        images: true,
      },
    });
    if (!product)
      throw new NotFoundException(ProductMessages.PRODUCT_NOT_FOUND);

    const bookmarkCount = await this.dataSource
      .createQueryBuilder()
      .select('COUNT(*)', 'count')
      .from('bookmark_products', 'bp')
      .where('bp.product_id = :id', { id })
      .getRawOne<{ count: string }>();

    product.users = [];
    const view = toAdminProductView(
      product,
      await this.resolveAvailability(product.variants.map((v) => v.id)),
    );
    view.bookmarkCount = Number(bookmarkCount?.count ?? 0);
    view.visibility = await this.visibility.readView(
      this.dataSource.manager,
      id,
    );
    return view;
  }

  // =========================================================================
  // UPDATE
  // =========================================================================

  /**
   * Single-transaction product update. See `UpdateProductDto` for the
   * category / image / variant contracts.
   *
   * Reads that feed the write BYPASS THE CACHE: the previous implementation
   * called the cached `findOne()` and then wrote the values back, so a stale
   * cached document could overwrite authoritative rows.
   */
  /**
   * @param actorPermissions the caller's effective capability codes.
   *
   * Needed here rather than on the controller because retiring a variant is
   * authorised by `products.deactivate`, and whether the request actually
   * retires one is only knowable once the existing row has been read inside
   * the transaction. A body that restates `isActive` without changing it is
   * not a deactivation and must not be refused as one.
   */
  async update(
    id: number,
    updateProductDto: UpdateProductDto,
    actor: AuditActor,
    actorPermissions: readonly string[] = [],
    options: { isSuperAdmin?: boolean } = {},
  ): Promise<AdminProductView> {
    const {
      categoryIds,
      title,
      description,
      basePrice,
      variants,
      images,
      productCode: rawProductCode,
      visibleOnSite,
      branchVisibility,
      branchIds,
    } = updateProductDto;

    const nextProductCode =
      rawProductCode === undefined
        ? undefined
        : assertProductCode(rawProductCode);

    /**
     * Did the caller say ANYTHING about visibility?
     *
     * A payload that mentions none of the three fields leaves the stored
     * configuration untouched and is never treated as an attempt to change it
     * — that is what keeps an ordinary title edit open to a delegated editor.
     */
    const touchesVisibility =
      visibleOnSite !== undefined ||
      branchVisibility !== undefined ||
      branchIds !== undefined;

    /** Filled inside the transaction, broadcast after it commits. */
    let touchedVariantIds: number[] = [];
    /*
     * Object keys of images this edit detaches. Hoisted for the same
     * reason as `touchedVariantIds`: the work it feeds must happen AFTER
     * the commit. Deleting bytes inside the transaction and then rolling
     * back would leave a surviving row pointing at nothing.
     */
    let detachedObjectKeys: string[] = [];

    await this.dataSource
      .transaction(async (manager) => {
        const productRepo = manager.getRepository(Product);

        /*
         * ===================================================================
         * LOCK ORDER: VARIANTS (ascending id) FIRST, THEN THE PRODUCT ROW.
         * ===================================================================
         *
         * This is not a preference, it is what makes this path deadlock-free
         * against `POST /orders/pos`, which locks in exactly that order:
         *
         *   POS sale   `InventoryService.lockVariants`  product_variants FOR UPDATE, id ASC
         *              `assertSellableInBranch`         products         FOR SHARE,  id ASC
         *
         *   this edit  `lockVariantsOfProduct`          product_variants FOR UPDATE, id ASC
         *              (the UPDATE below)               products         row-exclusive
         *
         * Both acquire variant locks before any product lock, and both take
         * variant locks in ascending id order, so no transaction can ever hold
         * a `products` lock while waiting for a `product_variants` lock. With
         * no edge in that direction the wait-for graph has no cycle, and a
         * deadlock is therefore impossible rather than merely unlikely.
         *
         * BEFORE THIS CHANGE THE ORDER WAS INVERTED AND COULD DEADLOCK: the
         * edit path issued `productRepo.save(product)` (taking the products row
         * lock) and only then reached `applyVariantContract`, which locks
         * variants. A concurrent till sale holding those variant rows and
         * waiting for the product's share lock closed the cycle. It needed a
         * variant edit and a sale on the same product in the same instant,
         * which is why it had not been seen — not because it could not happen.
         *
         * The lock is taken whenever this request could touch a variant at all.
         */
        const locksVariants =
          nextProductCode !== undefined || !!variants?.length;
        if (locksVariants) {
          await this.lockVariantsOfProduct(manager, id);
        }

        // Authoritative read -- no cache anywhere on this path.
        const product = await productRepo.findOne({
          where: { id },
          relations: { categories: true },
        });
        if (!product)
          throw new NotFoundException(ProductMessages.PRODUCT_NOT_FOUND);

        const before = {
          title: product.title,
          basePrice: product.basePrice ?? null,
          categoryIds: (product.categories ?? []).map((c) => c.id).sort(),
        };

        if (title !== undefined) product.title = title;
        if (description !== undefined) product.description = description;
        if (basePrice !== undefined) product.basePrice = basePrice;

        /*
         * A product code may be RETYPED, and the rename CASCADES to every
         * variant so the parent/child relationship stays true.
         *
         * `order_items` snapshots both codes at sale time, so no historical
         * receipt or report moves — which is precisely what makes the cascade
         * safe to perform rather than something to be afraid of.
         */
        const previousProductCode = product.productCode;
        const renames =
          nextProductCode !== undefined &&
          nextProductCode !== previousProductCode;

        if (nextProductCode !== undefined)
          product.productCode = nextProductCode;

        const effectiveProductCode = nextProductCode ?? previousProductCode;

        /*
         * Computed BEFORE the product row is written, and applied AFTER it, so
         * a conflict anywhere in the set aborts the whole request with nothing
         * changed. Every check runs against rows already locked above.
         */
        const cascade = renames
          ? await this.planVariantCodeCascade(
              manager,
              product.id,
              previousProductCode,
              effectiveProductCode,
            )
          : [];

        if (touchesVisibility) {
          const current = await this.visibility.read(manager, product.id);
          /*
           * MERGING A PARTIAL VISIBILITY PATCH.
           *
           * The branch list is inherited ONLY while the resulting mode is
           * still `selected`. Switching to `all` or `none` drops it.
           *
           * Inheriting unconditionally made the obvious request fail: a client
           * that sent `{branchVisibility:'all'}` on a product currently scoped
           * to two branches inherited those two ids, and `normaliseVisibility
           * Config` correctly refused the pair with
           * BRANCHES_NOT_ALLOWED_FOR_MODE — a 400 about a field the caller
           * never sent. Changing the mode IS the instruction to stop using the
           * list.
           *
           * A caller that EXPLICITLY sends `branchIds` alongside a
           * non-`selected` mode is still refused, because that request
           * contradicts itself and silently dropping half of it would persist
           * a configuration nobody asked for.
           */
          const nextMode = branchVisibility ?? current.branchVisibility;
          const inheritedBranchIds =
            nextMode === 'selected' ? current.branchIds : [];

          const resolved = await this.visibility.resolve(
            manager,
            {
              visibleOnSite: visibleOnSite ?? current.visibleOnSite,
              branchVisibility: nextMode,
              branchIds: branchIds ?? inheritedBranchIds,
            },
            { isSuperAdmin: options.isSuperAdmin === true, current },
          );
          await this.visibility.persist(manager, product.id, resolved);

          /*
           * MIRROR THE RESOLVED VALUES ONTO THE ENTITY.
           *
           * Not decoration — without this the change is silently undone.
           * `productRepo.save(product)` runs AFTER this block and writes every
           * column it holds, and `product` was loaded BEFORE the visibility
           * change, so it still carries the old `visibleOnSite` /
           * `branchVisibility`. TypeORM would faithfully write those stale
           * values back over the ones `persist` just committed.
           *
           * The symptom was not a silent revert but a 500: the join rows landed
           * while the mode reverted to its old value, and 0030's consistency
           * trigger correctly refused the pair at COMMIT
           * ("branchVisibility=all but 1 selected branch row(s)"). Every
           * visibility change made through `PATCH /products/:id` was affected.
           * It went unnoticed because the visibility suite drives the columns
           * through direct SQL, and the one case that does PATCH them expects a
           * 403.
           *
           * Both writes now carry identical values, so the second is a no-op
           * rather than a contradiction.
           */
          product.visibleOnSite = resolved.visibleOnSite;
          product.branchVisibility = resolved.branchVisibility;
        }

        if (categoryIds !== undefined) {
          product.categories = categoryIds.length
            ? await this.resolveCategories(manager, categoryIds)
            : [];
        }

        // save() (not update()) -- `Repository.update()` issues a plain
        // UPDATE on the products row and can NEVER write the
        // product_category junction, which is why category changes silently
        // did not persist before.
        await productRepo.save(product);

        /*
         * Applied AFTER the parent row, which is the only order the DEFERRABLE
         * constraint trigger from migration 0033 permits to be written
         * naturally: between these two statements the children still carry the
         * old prefix, which is momentarily invalid. Deferring the check to
         * COMMIT is what makes "rename the parent and all its children" one
         * atomic act rather than an impossible one.
         */
        if (cascade.length > 0) {
          await this.applyVariantCodeCascade(manager, cascade);

          await this.audit.record(
            {
              actor,
              action: AuditAction.PRODUCT_CODE_CHANGED,
              targetType: AuditTarget.PRODUCT,
              targetId: product.id,
              targetLabel: product.title,
              /*
               * Business identifiers and row ids only. No price, no stock, no
               * visibility configuration, no actor detail beyond what
               * `auditActorFrom` already records — the trail answers "which
               * code became which", which is the whole question a reader of
               * this entry has.
               */
              summary: {
                before: { productCode: previousProductCode },
                after: { productCode: effectiveProductCode },
                variants: cascade.map((row) => ({
                  variantId: row.variantId,
                  before: row.previousCode,
                  after: row.nextCode,
                })),
              },
            },
            manager,
          );
        }

        const variantOutcome = variants?.length
          ? await this.applyVariantContract(
              manager,
              product.id,
              variants,
              actorPermissions,
              effectiveProductCode,
              { actor, isSuperAdmin: options.isSuperAdmin === true },
            )
          : { touchedVariantIds: [], activationChanges: [] };
        // Hoisted out of the transaction so the broadcast below can run AFTER
        // the commit. Assigning here rather than returning keeps the existing
        // `.catch(translatePersistenceError)` chain intact.
        touchedVariantIds = variantOutcome.touchedVariantIds;

        if (images !== undefined) {
          detachedObjectKeys = await this.applyImageContract(
            manager,
            product.id,
            images,
          );
        }

        await this.audit.record(
          {
            actor,
            action: AuditAction.PRODUCT_UPDATED,
            targetType: AuditTarget.PRODUCT,
            targetId: product.id,
            targetLabel: product.title,
            // Allow-listed scalars only -- see the note in `create`. `images`
            // is deliberately absent: the contract replaces the whole set, so
            // the ids say nothing an auditor can act on.
            summary: {
              before,
              after: {
                title: product.title,
                basePrice: product.basePrice ?? null,
                categoryIds: (product.categories ?? []).map((c) => c.id).sort(),
              },
              variantIds: variantOutcome.touchedVariantIds,
            },
          },
          manager,
        );

        // A variant leaving or re-entering sale is its OWN act, not a detail
        // of a product edit: it is the change that decides whether a SKU can
        // be sold at all, and an auditor looking for "who retired this SKU"
        // searches by variant, not by the product that happened to carry it.
        for (const change of variantOutcome.activationChanges) {
          await this.audit.record(
            {
              actor,
              action: change.isActive
                ? AuditAction.VARIANT_ACTIVATED
                : AuditAction.VARIANT_DEACTIVATED,
              targetType: AuditTarget.VARIANT,
              targetId: change.id,
              targetLabel: change.sku,
              summary: { productId: product.id, sku: change.sku },
            },
            manager,
          );
        }
      })
      .catch((err) => {
        throw this.translatePersistenceError(err);
      });

    await this.catalogCache.invalidateProducts([id]);

    /*
     * A variant that just left or re-entered sale changes what the shop can
     * sell, so it is an availability change like any other -- and the one an
     * open storefront is least likely to survive without, because a retired SKU
     * stays addable to a basket until the page is reloaded.
     *
     * Post-commit and post-cache-drop, for the reasons spelled out in
     * `adjustVariantStock`. `publishAvailability` no longer re-reads the row:
     * the frame carries no state, so there is no promise to make from
     * committed data -- it names the variant and its product, and the client
     * asks. (This paragraph used to describe that re-read and the
     * `isActive && stock > 0` derivation that went with it. Both are gone.)
     *
     * A RETIREMENT REACHES THE TILL, not only the storefront. `catalogue` is
     * one of the POS-relevant reasons, so a cashier with the SKU already in an
     * open basket receives `pos:availability:invalidated`, refetches
     * `GET /inventory/availability`, sees `isActive: false` and is blocked
     * from checkout. The server refuses the sale regardless -- see
     * `InventoryService.assertSellableUnderLock` -- so the frame makes the
     * refusal legible to a cashier; it is not what enforces it.
     *
     * Every TOUCHED variant is published, not only the ones whose `isActive`
     * flipped: a variant contract can also create a variant or change the
     * attribute set that identifies it, and a storefront holding the old shape
     * needs to re-read either way. The event carries no quantity, so
     * over-announcing costs a refetch and leaks nothing.
     */
    // Committed: the rows that referenced these objects are gone, so the
    // bytes are now unreachable and safe to remove. Never throws.
    await this.discardStoredObjects(detachedObjectKeys);

    await this.publishAvailability(touchedVariantIds);

    /*
     * A VISIBILITY CHANGE IS AN AVAILABILITY CHANGE, and it touches no variant.
     *
     * Publishing or withdrawing a product writes only `products` rows, so
     * `touchedVariantIds` is empty and the block above announces nothing. An
     * open storefront would keep the product addable to a basket, and an open
     * till would keep it on the grid, until the next page load — which is
     * exactly the failure the invalidation channel exists to prevent.
     *
     * EVERY variant of the product is announced, because the frame is keyed by
     * variant and a client cannot map a product to its variants without asking.
     * The reason is `catalogue`, which is POS-RELEVANT, so the frame reaches
     * `staff:availability` as well as the public room — a cashier whose basket
     * holds a line that just left their branch is told to refetch.
     *
     * The frame itself stays a bare pointer: `{variantId, productId, reason}`.
     * NO branch list, NO mode, NO site flag travels on a public or POS socket.
     * The client refetches through its own authoritative endpoint, which
     * applies the same gate it would have applied anyway.
     */
    if (touchesVisibility) {
      const rows: Array<{ id: number }> = await this.productRepository.query(
        `SELECT "id" FROM "product_variants" WHERE "productId" = $1`,
        [id],
      );
      await this.publishAvailability(
        rows.map((r) => Number(r.id)),
        'catalogue',
      );
    }

    return this.findOneAdmin(id);
  }

  // =========================================================================
  // VARIANT / PRODUCT INTEGRITY  (B4 -- consumed by cart, orders and POS)
  // =========================================================================

  /**
   * Assert that `variantId` really is a variant of `productId`.
   *
   * Cart, checkout and POS all accept a (productId, variantId) pair from the
   * client. Without this check a caller can pair a cheap product with an
   * expensive product's variant, or vice versa, and the price/stock that gets
   * charged and decremented belongs to a different product entirely.
   *
   * @param manager  the caller's EntityManager so the check composes into the
   *                 caller's transaction (and sees its uncommitted writes).
   *                 Pass `undefined` outside a transaction.
   *
   * A mismatch raises 400 rather than 404 on purpose: answering 404 would tell
   * an attacker which variant ids exist.
   */
  async assertVariantBelongsToProduct(
    manager: EntityManager | undefined,
    productId: number,
    variantId: number,
    options: { requireActive?: boolean } = {},
  ): Promise<ProductVariant> {
    if (!Number.isInteger(productId) || !Number.isInteger(variantId)) {
      throw new BadRequestException(
        ProductMessages.VARIANT_DOES_NOT_BELONG_TO_PRODUCT,
      );
    }

    const repo = (manager ?? this.dataSource.manager).getRepository(
      ProductVariant,
    );

    const variant = await repo.findOne({
      where: { id: variantId },
      relations: { product: true },
    });

    if (!variant) {
      throw new NotFoundException(ProductMessages.PRODUCT_VARIANT_NOT_FOUND);
    }
    if (!variant.product || variant.product.id !== productId) {
      throw new BadRequestException(
        ProductMessages.VARIANT_DOES_NOT_BELONG_TO_PRODUCT,
      );
    }
    if (options.requireActive && variant.isActive === false) {
      throw new BadRequestException(ProductMessages.VARIANT_INACTIVE);
    }
    return variant;
  }

  // =========================================================================
  // BOOKMARK  (B2)
  // =========================================================================

  /**
   * Toggle the CALLER's bookmark on a product.
   *
   * `userId` comes from the verified access token, never from the body: the
   * previous signature took it from `BookmarkProductDto` so any authenticated
   * user could bookmark (or un-bookmark) on behalf of anybody.
   *
   * The membership test runs as a junction-table query rather than
   * `product.users.some(...)`: `users` was never loaded by the cached
   * `findOne()`, so the old code dereferenced `undefined` and every call
   * returned a 500.
   */
  async bookmark(
    userId: number,
    productId: number,
  ): Promise<{ bookmarked: boolean }> {
    const product = await this.productRepository.findOne({
      where: { id: productId },
      select: { id: true },
    });
    if (!product)
      throw new NotFoundException(ProductMessages.PRODUCT_NOT_FOUND);

    const relation = this.productRepository
      .createQueryBuilder()
      .relation(Product, 'users')
      .of(productId);

    const existing: unknown = await this.dataSource
      .createQueryBuilder()
      .select('1', 'one')
      .from('bookmark_products', 'bp')
      .where('bp.product_id = :productId AND bp.user_id = :userId', {
        productId,
        userId,
      })
      .getRawOne();

    if (existing) {
      await relation.remove(userId);
      return { bookmarked: false };
    }

    const user = await this.dataSource.getRepository(User).findOne({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException(ProductMessages.PRODUCT_NOT_FOUND);

    await relation.add(userId);
    return { bookmarked: true };
  }

  // =========================================================================
  // STOCK ADJUSTMENT  (B7)
  // =========================================================================

  /**
   * Admin stock edit. Delegates the actual mutation to
   * `IInventoryService.adjustStock`, which does it under a row lock and writes
   * a `stock_movements` row -- this method never touches
   * `product_variants.stock` itself.
   *
   * The pre-check below exists to produce a useful 409 body (it reports what
   * is reserved and by whom-kind). It is NOT the authority: the availability
   * read is unlocked, so between it and `adjustStock` a reservation can appear.
   * `adjustStock` repeats the check under the lock; that one is authoritative.
   */
  async adjustVariantStock(
    variantId: number,
    dto: AdjustVariantStockDto,
    actor: { userId: number; displaySnapshot: string },
  ): Promise<AdjustVariantStockResponse> {
    const inventory = this.inventoryService;

    const variant = await this.productVariantRepository.findOne({
      where: { id: variantId },
      relations: { product: true },
    });
    if (!variant)
      throw new NotFoundException(ProductMessages.PRODUCT_VARIANT_NOT_FOUND);

    if (dto.mode === StockAdjustModeDto.SET && dto.value < 0) {
      throw new BadRequestException(ProductMessages.STOCK_NEGATIVE_NOT_ALLOWED);
    }

    const result = await this.dataSource.transaction(async (manager) => {
      const before = (
        await inventory.getAvailability(manager, [variantId])
      ).get(variantId);

      if (before) {
        const target =
          dto.mode === StockAdjustModeDto.SET
            ? dto.value
            : before.physicalStock + dto.value;

        if (target < 0) {
          throw new BadRequestException(
            ProductMessages.STOCK_NEGATIVE_NOT_ALLOWED,
          );
        }

        const reserved = before.basketReserved + before.orderAllocated;
        if (target < reserved && !dto.allowBelowReserved) {
          // The global error envelope (GlobalExceptionFilter) carries only
          // `message` and `error`; any extra key on the exception payload is
          // dropped. The reserved quantities are therefore reported INSIDE the
          // message, because an admin being told "no" without being told what
          // is holding the stock cannot act on the refusal.
          throw new ConflictException({
            message:
              `${ProductMessages.STOCK_BELOW_RESERVED} ` +
              `(variantId=${variantId}, requestedStock=${target}, ` +
              `physicalStock=${before.physicalStock}, ` +
              `basketReserved=${before.basketReserved}, ` +
              `orderAllocated=${before.orderAllocated})`,
            error: 'STOCK_BELOW_RESERVED',
          });
        }
      }

      return inventory.adjustStock(manager, {
        variantId,
        mode: dto.mode === StockAdjustModeDto.SET ? 'set' : 'delta',
        value: dto.value,
        actorUserId: actor.userId,
        actorDisplaySnapshot: actor.displaySnapshot,
        reason: dto.reason,
        allowBelowReserved: dto.allowBelowReserved ?? false,
      });
    });

    // Post-commit, advisory. A cache failure must not undo a committed
    // stock movement, which is why this is outside the transaction.
    await this.catalogCache.invalidateVariantAvailability([variantId]);

    /*
     * =======================================================================
     * ANNOUNCE THE ADJUSTMENT -- AFTER the commit and AFTER the cache drop
     * =======================================================================
     *
     * Ordering is load-bearing in both directions.
     *
     * After the COMMIT, because an event emitted from inside the transaction
     * announces a number that may still roll back, and every listener's first
     * reaction is to re-read. A listener that re-read mid-transaction would see
     * the pre-commit value and cache it as the new truth.
     *
     * After the CACHE DROP, because the listeners' re-read goes through the
     * same catalogue cache this just invalidated. Emitting first would race the
     * invalidation and hand some clients the number they already had.
     *
     * `newStock` is `balanceAfter` -- the value the conditional UPDATE actually
     * wrote and RETURNINGed (inventory rule R7), never a figure recomputed here
     * from the pre-lock snapshot.
     *
     * `branchId: null` is correct and deliberate: an administrator correcting a
     * count is not a till transaction, and `product_variants.stock` is one
     * number for the whole business. Per `emitStockEvent`, a null branch means
     * a SMALLER audience -- `admins` only, never a fallback to everyone.
     *
     * Which is exactly why the second event matters. A POS terminal sits in
     * `branch:<id>` and not in `admins`, so it NEVER receives this
     * `stock:updated`. It learns from `availability:updated`, the global
     * broadcast, and then re-reads `GET /inventory/availability` for the exact
     * sellable figure. That pair is what makes an admin correction show up on a
     * till without giving retail customers an exact count.
     */
    this.realtimeGateway.emitStockEvent({
      variantId,
      newStock: result.balanceAfter,
      branchId: null,
    });
    /*
     * The till no longer depends on the public broadcast to learn this.
     *
     * An administrator's correction carries no branch, so `stock:updated`
     * reaches the super-admin room only and never the branch room a cashier
     * sits in — which is why the till used to subscribe to the customer-facing
     * event as a workaround. `publishAvailabilityInvalidation` routes a `stock`
     * reason to the staff availability room as well, which every till joins
     * regardless of branch, because physical stock is not a branch-partitioned
     * fact in this schema.
     */
    await this.realtimeGateway.publishAvailabilityInvalidation(
      [variantId],
      'stock',
    );

    return {
      ...result,
      productId: variant.product?.id ?? 0,
      sku: variant.sku,
    };
  }

  // =========================================================================
  // IMAGES
  // =========================================================================

  /**
   * Store one image and return it DETACHED.
   *
   * TWO SYSTEMS, ONE ACT, AND NO TRANSACTION ACROSS THEM. The bytes go to
   * object storage and the row goes to PostgreSQL, and nothing can make those
   * two commit together. The order is therefore chosen so that the failure
   * mode is the recoverable one:
   *
   *   object first, row second. If the row fails, the object is deleted again
   *   (below) and the caller is told the upload failed — which is true, and
   *   leaves nothing behind.
   *
   *   The other order — row first, object second — would leave a row pointing
   *   at bytes that do not exist. The Admin console would show a broken
   *   thumbnail, the image could be attached to a product, and the storefront
   *   would serve a 404 to customers. A row without an object is a lie that
   *   propagates; an object without a row is only litter.
   *
   * COMPENSATION IS IMMEDIATE, THEN DURABLE. The object is deleted straight
   * away; if that fails — the same outage that broke the insert, most likely —
   * the key is written to `object_deletion_jobs` in a transaction of its own,
   * because there is no caller transaction left to join. The worker retries it
   * from there.
   *
   * Only if BOTH the delete and that write fail is anything actually lost, and
   * the log says so in those terms rather than claiming a sweep that cannot
   * happen. That residual case needs a bucket lifecycle rule; it is the one
   * storage-level requirement this design cannot remove, because it is the
   * case where there is nothing left to write to.
   *
   * What must never happen is the compensation's failure replacing the
   * ORIGINAL failure in the response: the caller needs to know their upload did
   * not work, not that a cleanup they never asked for did not work either.
   */
  async upload(file: Express.Multer.File): Promise<ProductImage> {
    // Everything the request claimed is re-derived from the bytes here. See
    // `verifyProductImageUpload` for why the declared MIME type is not input.
    const verified = verifyProductImageUpload(file, this.productImageMaxBytes);

    const stored = await this.storage.putImage(
      verified.buffer,
      verified.contentType,
    );

    try {
      return await this.productImageRepository.save(
        this.productImageRepository.create({
          url: stored.url,
          objectKey: stored.key,
          sortOrder: null,
        }),
      );
    } catch (cause) {
      const compensated = await this.storage
        .deleteObject(stored.key)
        .catch(() => false);

      if (compensated) {
        this.logger.warn(
          `Image row insert failed; the just-uploaded object was deleted ` +
            `(key=${stored.key}). Nothing was left behind.`,
        );
      } else {
        /*
         * The object is in the bucket and its row was never written, so
         * nothing in the catalogue names it. WRITE THE NAME DOWN before
         * giving up: a deletion job in its own transaction is the only thing
         * that can make this recoverable, and the database is usually fine
         * here — the insert typically failed on a constraint, not an outage.
         */
        const recorded = await this.objectDeletion.enqueueStandalone(
          stored.key,
          ObjectDeletionOrigin.UPLOAD_COMPENSATION,
        );
        if (recorded) {
          this.logger.warn(
            `Image row insert failed and the compensating delete did not ` +
              `succeed; key=${stored.key} is now recorded in ` +
              `object_deletion_jobs and the worker will retry it.`,
          );
        } else {
          /*
           * Storage failed, the row failed, and the database could not even
           * record the intent. There is nothing left to write to, so this is
           * the one residual case that genuinely needs storage-level
           * lifecycle: a bucket expiry rule on the `products/` prefix for
           * objects no row references. Documented in .env.example and the PR.
           */
          this.logger.error(
            `Image row insert failed, the compensating delete failed, AND the ` +
              `deletion job could not be persisted. key=${stored.key} is ` +
              `unreferenced, still present, and NOT recorded anywhere. It can ` +
              `only be reclaimed by a bucket lifecycle rule or by hand.`,
          );
        }
      }

      throw cause;
    }
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * Indicative availability for a set of variants.
   *
   * Uses the inventory contract, so the number the storefront sees is
   * `availableForBasket` (physical minus basket holds minus order allocations)
   * rather than a raw shelf count that is already spoken for. Falls back to
   * physical stock if that read fails, because a catalog page must still
   * render when inventory is degraded -- it is flagged indicative either way.
   *
   * NEVER cached -- see the header comment on `CatalogCacheService`.
   */
  private async resolveAvailability(
    variantIds: number[],
  ): Promise<Map<number, AvailabilityView>> {
    const out = new Map<number, AvailabilityView>();
    const ids = [...new Set(variantIds)].filter((n) => Number.isInteger(n));
    if (!ids.length) return out;

    const asOf = new Date().toISOString();

    try {
      const snapshots = await this.dataSource.transaction((manager) =>
        this.inventoryService.getAvailability(manager, ids),
      );
      for (const [variantId, snapshot] of snapshots) {
        const qty = Math.max(0, snapshot.availableForBasket);
        out.set(variantId, {
          availableForBasket: qty,
          inStock: qty > 0,
          indicative: true,
          asOf,
        });
      }
      return out;
    } catch (err) {
      this.logger.warn(
        `Falling back to physical stock for availability: ${
          (err as Error).message
        }`,
      );
    }

    const variants = await this.productVariantRepository.find({
      where: { id: In(ids) },
      select: { id: true, stock: true },
    });
    for (const v of variants) {
      out.set(v.id, {
        availableForBasket: Math.max(0, v.stock),
        inStock: v.stock > 0,
        indicative: true,
        asOf,
      });
    }
    return out;
  }

  private buildFilteredQuery(query: QueryProductsDto) {
    const qb = this.productRepository.createQueryBuilder('p');

    /*
     * THE WEBSITE CHANNEL GATE (migration 0030).
     *
     * Unconditional and first: listing, search and category filtering all
     * build on this one query, so a product withdrawn from the site is
     * invisible on every public surface at once rather than in the three
     * places somebody remembered.
     *
     * It is NOT a variant-level rule and does not replace one. A product may
     * be on the site and still have no sellable variant; both conditions are
     * evaluated, independently.
     */
    qb.andWhere(productVisibleOnSiteSql('p'));

    if (query.search) {
      qb.andWhere('LOWER(p.title) LIKE :search', {
        search: `%${query.search.toLowerCase()}%`,
      });
    }

    if (query.categoryId !== undefined) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM "product_category" pc
                  WHERE pc."product_id" = p."id"
                    AND pc."category_id" = :categoryId)`,
        { categoryId: query.categoryId },
      );
    }

    if (query.inStockOnly) {
      qb.andWhere(IN_STOCK_SQL).setParameter(
        'availabilityAt',
        availabilityAt(),
      );
    }

    if (query.minPrice !== undefined) {
      qb.andWhere(`${EFFECTIVE_PRICE_SQL} >= :minPrice`, {
        minPrice: query.minPrice,
      });
    }

    if (query.maxPrice !== undefined) {
      qb.andWhere(`${EFFECTIVE_PRICE_SQL} <= :maxPrice`, {
        maxPrice: query.maxPrice,
      });
    }

    return qb;
  }

  /**
   * Admin filters. Separate from `buildFilteredQuery` on purpose: the public
   * one silently means "active variants only" everywhere, which is the exact
   * opposite of what an admin filter must do.
   */
  private buildAdminFilteredQuery(query: QueryAdminProductsDto) {
    const qb = this.productRepository.createQueryBuilder('p');

    if (query.search) {
      // Title OR any SKU. The SKU arm is an EXISTS rather than a join: joining
      // `product_variants` would multiply the product row once per matching
      // variant and quietly break both the count and the page size.
      qb.andWhere(
        `(LOWER(p.title) LIKE :search
          OR EXISTS (SELECT 1 FROM "product_variants" ssv
                      WHERE ssv."productId" = p."id"
                        AND LOWER(ssv."sku") LIKE :search))`,
        { search: `%${query.search.toLowerCase()}%` },
      );
    }

    if (query.categoryId !== undefined) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM "product_category" pc
                  WHERE pc."product_id" = p."id"
                    AND pc."category_id" = :categoryId)`,
        { categoryId: query.categoryId },
      );
    }

    if (query.sellable !== undefined) {
      // `sellable=false` includes the product with NO variants at all. It is
      // not sellable either, and it is the one an admin most needs to find.
      qb.andWhere(
        query.sellable
          ? `${ACTIVE_VARIANT_COUNT_SQL} > 0`
          : `${ACTIVE_VARIANT_COUNT_SQL} = 0`,
      );
    }

    if (query.stockState !== undefined) {
      switch (query.stockState) {
        case AdminStockState.OUT_OF_STOCK:
          qb.andWhere(`${ACTIVE_STOCK_TOTAL_SQL} = 0`);
          break;
        case AdminStockState.LOW_STOCK:
          qb.andWhere(
            `${ACTIVE_STOCK_TOTAL_SQL} > 0 AND ${ACTIVE_STOCK_TOTAL_SQL} <= :lowStockThreshold`,
            { lowStockThreshold: LOW_STOCK_THRESHOLD },
          );
          break;
        case AdminStockState.IN_STOCK:
          qb.andWhere(`${ACTIVE_STOCK_TOTAL_SQL} > :lowStockThreshold`, {
            lowStockThreshold: LOW_STOCK_THRESHOLD,
          });
          break;
      }
    }

    return qb;
  }

  private applySort(
    qb: ReturnType<ProductsService['buildFilteredQuery']>,
    sort: ProductSort,
  ): void {
    switch (sort) {
      case ProductSort.PRICE_ASC:
        qb.orderBy('"effective_price"', 'ASC', 'NULLS LAST');
        break;
      case ProductSort.PRICE_DESC:
        qb.orderBy('"effective_price"', 'DESC', 'NULLS LAST');
        break;
      case ProductSort.NEWEST:
      default:
        qb.orderBy('p.created_at', 'DESC');
        break;
    }
    // Deterministic tiebreak so page N+1 never repeats or skips a row.
    qb.addOrderBy('p.id', 'DESC');
  }

  private buildListCacheDiscriminator(
    query: QueryProductsDto,
    page: number,
    limit: number,
    sort: ProductSort,
  ): string {
    return [
      `p${page}`,
      `l${limit}`,
      `s${encodeURIComponent(query.search ?? '')}`,
      `c${query.categoryId ?? ''}`,
      `mn${query.minPrice ?? ''}`,
      `mx${query.maxPrice ?? ''}`,
      `st${query.inStockOnly ? 1 : 0}`,
      `o${sort}`,
    ].join('|');
  }

  private async resolveCategories(
    manager: EntityManager,
    categoryIds: number[],
  ): Promise<Category[]> {
    const unique = [...new Set(categoryIds)];
    const categories = await manager.getRepository(Category).findBy({
      id: In(unique),
    });
    if (categories.length !== unique.length) {
      throw new NotFoundException(CategoryMessages.CATEGORY_NOT_FOUND);
    }
    return categories;
  }

  private async resolveAttributeValues(
    manager: EntityManager,
    attributeValueIds: number[] | undefined,
  ): Promise<ProductAttributeValue[]> {
    if (!attributeValueIds?.length) {
      throw new NotFoundException(AttributeMessages.ATTRIBUTE_VALUE_NOT_FOUND);
    }
    const unique = [...new Set(attributeValueIds)];
    const values = await manager
      .getRepository(ProductAttributeValue)
      .findBy({ id: In(unique) });
    if (values.length !== unique.length) {
      throw new NotFoundException(AttributeMessages.ATTRIBUTE_VALUE_NOT_FOUND);
    }
    return values;
  }

  /**
   * Creates the single DEFAULT variant of a simple (option-less) product.
   *
   * PRICE. `product_variants.price` and `products.basePrice` are BOTH `bigint`
   * INTEGER RIAL -- same column type in migration 0001, same
   * `bigIntTransformer` on both entity properties, and `EFFECTIVE_PRICE_SQL`
   * above already COALESCEs one into the other and feeds the result to a single
   * price filter and sort. So `basePrice` is copied VERBATIM: no scaling, no
   * conversion. A product created without a basePrice gets price 0, exactly as
   * a variant created without a price does.
   *
   * `basePrice` remains on the product and remains the value the admin edits.
   * INTENDED DIRECTION: it becomes a display-only "from" price and
   * `product_variants.price` becomes the sole authority for what is charged.
   * Nothing here re-points existing reads at the variant price; that is a
   * separate, deliberate change.
   *
   * STOCK is 0. See `create()`.
   */
  private async createDefaultVariant(
    manager: EntityManager,
    productId: number,
    productDto: { basePrice?: number },
    productCode: string,
  ): Promise<number> {
    const variantRepo = manager.getRepository(ProductVariant);
    /*
     * The default variant is created by the system, not by the operator, so
     * its code is ALLOCATED rather than demanded. It goes through the same
     * sequence as the «تولید خودکار کد» button, so a simple product's variant
     * code is indistinguishable from a hand-generated one.
     */
    const { variantCode } = await this.productCodes.nextVariantCode(
      productCode,
      manager,
    );
    const saved = await variantRepo.save(
      variantRepo.create({
        product: { id: productId } as Product,
        sku: await this.resolveDefaultVariantSku(manager, productId),
        variantCode,
        price: productDto.basePrice ?? 0,
        stock: 0,
        isActive: true,
        isDefault: true,
        // A default variant is the product itself, so it carries no options.
        attributeValues: [],
      }),
    );
    return saved.id;
  }

  /**
   * `DEFAULT-P<productId>`, probed for collisions.
   *
   * The product id makes it deterministic and unique by construction, but
   * `sku` is globally unique (`UQ_46f236f21640f9da218a063a866`), so a
   * hand-written SKU could already occupy the name. Probing and suffixing beats
   * letting the INSERT fail: the alternative is a 409 on a create request the
   * admin cannot fix, because the colliding SKU may belong to a product they
   * cannot see.
   */
  private async resolveDefaultVariantSku(
    manager: EntityManager,
    productId: number,
  ): Promise<string> {
    const repo = manager.getRepository(ProductVariant);
    const stem = `${DEFAULT_VARIANT_SKU_PREFIX}${productId}`;

    for (
      let attempt = 0;
      attempt <= DEFAULT_VARIANT_SKU_MAX_ATTEMPTS;
      attempt++
    ) {
      const candidate = attempt === 0 ? stem : `${stem}-${attempt}`;
      const taken = await repo.count({ where: { sku: candidate } });
      if (taken === 0) return candidate;
    }
    throw new ConflictException(ProductMessages.VARIANT_SKU_ALREADY_EXISTS);
  }

  /**
   * Normalise every submitted variant code against its parent, refusing
   * duplicates WITHIN THE PAYLOAD before the database sees them.
   *
   * The in-payload check exists for the same reason `assertNoDuplicateSkus`
   * does: two identical codes in one request would otherwise surface as a
   * confusing 409 about a row the operator is in the middle of creating,
   * rather than a 400 about the form they are looking at.
   */
  private normaliseVariantCodes(
    variants: CreateVariantDto[] | undefined,
    productCode: string,
  ): Map<CreateVariantDto, string> {
    const out = new Map<CreateVariantDto, string>();
    if (!variants?.length) return out;

    const seen = new Set<string>();
    for (const variant of variants) {
      const code = assertVariantCode(variant.variantCode);
      assertVariantBelongsToProduct(code, productCode);
      if (seen.has(code)) {
        throw new BadRequestException({
          error: ProductCodeErrorCodes.VARIANT_CODE_TAKEN,
          message: ProductCodeMessages.variantCode.TAKEN,
          details: { field: 'variantCode', variantCode: code },
        });
      }
      seen.add(code);
      out.set(variant, code);
    }
    return out;
  }

  /**
   * Canonicalise one variant code and check it against its parent.
   *
   * `productCode` is optional only because `applyVariantContract` can be
   * reached on an update that did not name the product code; in that case the
   * caller passes the STORED one, so the relationship is always checked
   * against something real.
   */
  private requireVariantCode(
    raw: string | undefined,
    productCode: string | undefined,
  ): string {
    const code = assertVariantCode(raw);
    if (productCode !== undefined) {
      assertVariantBelongsToProduct(code, productCode);
    }
    return code;
  }

  /**
   * Lock every variant row of one product, ASCENDING BY ID.
   *
   * Ascending id is the same order `InventoryService.lockVariants` uses, so two
   * transactions that both touch a subset of these rows queue rather than
   * deadlock. Taking it before any `products` write is what keeps this path on
   * the same side of the global variants-then-products order as the till.
   *
   * It returns nothing: the point is the lock, not the data. The authoritative
   * read of the codes happens in `planVariantCodeCascade`, after this.
   */
  private async lockVariantsOfProduct(
    manager: EntityManager,
    productId: number,
  ): Promise<void> {
    await manager.query(
      `SELECT "id" FROM "product_variants"
        WHERE "productId" = $1
        ORDER BY "id" ASC
          FOR UPDATE`,
      [productId],
    );
  }

  /**
   * Work out every variant's new code and prove the whole set is writable,
   * WITHOUT writing anything.
   *
   * Separated from the apply step so a conflict on the last variant of a
   * hundred aborts before the first one has moved. Everything here reads rows
   * this transaction already holds a lock on.
   *
   * Four checks, in the order the requirement states them:
   *   1. canonical format          — `assertVariantCode`
   *   2. relationship to the NEW parent — `assertVariantBelongsToProduct`
   *   3. duplicates inside the product  — the `seen` set
   *   4. conflicts with OTHER products' variants — one indexed query
   *
   * A variant that does not currently carry the old parent prefix is REFUSED
   * rather than repaired (see `reprefixVariantCode`). It can only exist as
   * drift predating migration 0033, and inventing a code for it would be
   * fabricating a business identifier.
   */
  private async planVariantCodeCascade(
    manager: EntityManager,
    productId: number,
    previousProductCode: string,
    nextProductCode: string,
  ): Promise<VariantCodeRename[]> {
    /*
     * THE PRODUCT CODE ITSELF, CHECKED FIRST.
     *
     * Without this the operator gets the wrong noun. Renaming to a code another
     * product already holds makes that product's variant suffixes collide too,
     * so the per-variant check below fires and reports VARIANT_CODE_TAKEN — a
     * refusal about a field they never typed, naming a variant they have never
     * seen. The root cause is the product code, so that is what is named.
     *
     * The unique index still has the final say; this only decides which of two
     * true statements is the useful one.
     */
    const productClash = await manager.query<Array<{ id: number }>>(
      `SELECT "id" FROM "products"
        WHERE "productCode" = $1 AND "id" <> $2
        LIMIT 1`,
      [nextProductCode, productId],
    );
    if (productClash.length > 0) {
      throw new ConflictException({
        error: ProductCodeErrorCodes.PRODUCT_CODE_TAKEN,
        message: ProductCodeMessages.productCode.TAKEN,
        field: 'productCode',
        productCode: nextProductCode,
      });
    }

    const rows = await manager.query<
      Array<{ id: number; variantCode: string }>
    >(
      `SELECT "id", "variantCode" FROM "product_variants"
        WHERE "productId" = $1
        ORDER BY "id" ASC`,
      [productId],
    );
    if (rows.length === 0) return [];

    const planned: VariantCodeRename[] = [];
    const seen = new Set<string>();

    for (const row of rows) {
      const previousCode = row.variantCode;
      const nextCode = reprefixVariantCode(
        previousCode,
        previousProductCode,
        nextProductCode,
      );

      // 1 + 2. The rewritten value must stand on its own as a valid code that
      // belongs to the new parent — not merely as a string concatenation.
      assertVariantCode(nextCode);
      assertVariantBelongsToProduct(nextCode, nextProductCode);

      // 3. Two variants of this product cannot land on one code. Unreachable
      //    while suffixes are unique, which is exactly why it is asserted
      //    rather than assumed.
      if (seen.has(nextCode)) {
        throw new ConflictException({
          error: ProductCodeErrorCodes.VARIANT_CODE_TAKEN,
          message: ProductCodeMessages.variantCode.TAKEN,
          field: 'variantCode',
          variantCode: nextCode,
        });
      }
      seen.add(nextCode);

      planned.push({
        variantId: Number(row.id),
        previousCode,
        nextCode,
      });
    }

    // 4. Collision with a variant of ANOTHER product. The unique index would
    //    catch it at write time, but only as a 23505 naming no field; asking
    //    first lets the refusal name the exact code the operator must change.
    const clashes = await manager.query<Array<{ variantCode: string }>>(
      `SELECT v."variantCode"
         FROM "product_variants" v
        WHERE v."variantCode" = ANY($1::text[])
          AND v."productId" <> $2
        LIMIT 1`,
      [planned.map((row) => row.nextCode), productId],
    );
    const clash = clashes[0];
    if (clash !== undefined) {
      throw new ConflictException({
        error: ProductCodeErrorCodes.VARIANT_CODE_TAKEN,
        message: ProductCodeMessages.variantCode.TAKEN,
        field: 'variantCode',
        variantCode: clash.variantCode,
      });
    }

    return planned;
  }

  /**
   * Write the planned renames.
   *
   * One statement for the whole set rather than a loop of updates: it is a
   * single round trip, and it cannot half-apply if the connection drops between
   * two of them. `unnest` pairs the ids with their codes positionally.
   *
   * A 23505 here — a code taken between the plan and this write by a concurrent
   * transaction that did not hold these row locks — is translated by
   * `translatePersistenceError` into the same 409 the pre-check would have
   * produced, so the two paths are indistinguishable to the client.
   */
  private async applyVariantCodeCascade(
    manager: EntityManager,
    planned: readonly VariantCodeRename[],
  ): Promise<void> {
    await manager.query(
      `UPDATE "product_variants" AS v
          SET "variantCode" = c."code"
         FROM (SELECT unnest($1::int[]) AS id, unnest($2::text[]) AS code) AS c
        WHERE v."id" = c."id"`,
      [planned.map((r) => r.variantId), planned.map((r) => r.nextCode)],
    );
  }

  private assertNoDuplicateSkus(skus: (string | undefined)[]): void {
    const present = skus.filter((s): s is string => !!s);
    if (new Set(present).size !== present.length) {
      throw new BadRequestException(ProductMessages.VARIANT_SKU_ALREADY_EXISTS);
    }
  }

  /**
   * VARIANT LIFECYCLE CONTRACT -- see `UpdateProductDto`.
   * Partial upsert: entries without `id` create, entries with `id` update,
   * `isActive:false` deactivates, unmentioned variants are untouched, nothing
   * is ever hard-deleted.
   *
   * -------------------------------------------------------------------------
   * THE DEFAULT VARIANT (migration 0012) UNDER THIS CONTRACT -- the rule, and
   * why it is this rule:
   *
   * 1. ADDING REAL VARIANTS TO A SIMPLE PRODUCT DOES NOT RETIRE THE DEFAULT.
   *    Variants created here are ordinary ones (`isDefault` defaults to false),
   *    and the existing default keeps its flag and stays active. Auto-retiring
   *    it was rejected: the default carries COUNTED PHYSICAL STOCK, and it may
   *    carry live basket reservations and order allocations. Deactivating it as
   *    a side effect of an unrelated edit would strand real units -- units
   *    somebody counted -- with no ledger entry saying where they went. That is
   *    exactly the kind of silent reinterpretation the sellable-SKU work exists
   *    to stop. An admin who wants the plain SKU gone says so explicitly, with
   *    `{ id, isActive: false }`, and can move its stock first.
   *
   *    Consequence, which is intended: while the default is still active, a
   *    basket request that names only the product resolves to it, and the
   *    storefront lists it beside the option variants.
   *
   * 2. `isDefault` IS NOT SETTABLE THROUGH THIS ENDPOINT. `UpsertVariantDto`
   *    has no such field. The flag decides where a product-only basket request
   *    lands, so letting it be moved by a routine catalog edit would silently
   *    change what a customer's "add to basket" adds. It is set once, when a
   *    simple product is created (or backfilled by 0012).
   *
   * 3. DEACTIVATING EVERY VARIANT IS ALLOWED and means "this product is
   *    discontinued". It is NOT blocked, because refusing would leave no way to
   *    retire a product at all. The product does not become
   *    sellable-with-no-SKU: `CartService.resolveTarget` rejects it with
   *    PRODUCT_NOT_SELLABLE, the public detail view lists no variants, and the
   *    list card reports `inStock: false` / `variantCount: 0`.
   *
   * RETURNS what it touched, so the caller can audit it. The activation list
   * holds only variants whose `isActive` genuinely CHANGED -- a payload that
   * re-sends `isActive: true` on an already-active variant must not write a
   * "variant activated" row, or the trail fills with acts nobody performed and
   * the real retirement becomes impossible to find.
   */
  private async applyVariantContract(
    manager: EntityManager,
    productId: number,
    variants: UpsertVariantDto[],
    actorPermissions: readonly string[] = [],
    productCode?: string,
    costContext: { actor: AuditActor | null; isSuperAdmin: boolean } = {
      actor: null,
      isSuperAdmin: false,
    },
  ): Promise<VariantContractOutcome> {
    const variantRepo = manager.getRepository(ProductVariant);
    const outcome: VariantContractOutcome = {
      touchedVariantIds: [],
      activationChanges: [],
    };

    this.assertNoDuplicateSkus(variants.map((v) => v.sku));

    for (const dto of variants) {
      if (dto.id === undefined) {
        // ---- CREATE -----------------------------------------------------
        if (!dto.sku) {
          throw new BadRequestException(ProductMessages.VARIANT_SKU_REQUIRED);
        }
        if (!dto.attributeValueIds?.length) {
          throw new BadRequestException(
            ProductMessages.VARIANT_ATTRIBUTE_VALUES_REQUIRED,
          );
        }
        /*
         * A NEW variant may bring opening units — with their cost, exactly as
         * on create (docs §6). Parsed and authorised before the INSERT.
         */
        const cost = parsePurchaseCost(
          dto.purchasePrice,
          'variants[].purchasePrice',
        );
        if (cost !== undefined && !costContext.isSuperAdmin) {
          throw costingError.forbidden(
            CostingErrorCodes.PURCHASE_COST_FORBIDDEN,
            { field: 'variants[].purchasePrice' },
          );
        }
        const openingQuantity = Math.trunc(dto.stock ?? 0);
        if (openingQuantity > 0 && cost === undefined) {
          throw costingError.badRequest(
            CostingErrorCodes.INITIAL_STOCK_REQUIRES_PURCHASE_COST,
            { field: 'variants[].purchasePrice' },
          );
        }
        const created = await variantRepo.save(
          variantRepo.create({
            product: { id: productId } as Product,
            sku: dto.sku,
            variantCode: this.requireVariantCode(dto.variantCode, productCode),
            price: dto.price ?? 0,
            // Units arrive as a valued movement below, never on the INSERT.
            stock: 0,
            isActive: dto.isActive ?? true,
            attributeValues: await this.resolveAttributeValues(
              manager,
              dto.attributeValueIds,
            ),
          }),
        );
        if (openingQuantity > 0) {
          await this.inventoryService.recordInitialStock(manager, {
            variantId: created.id,
            quantity: openingQuantity,
            unitCost: cost!,
            actorUserId: costContext.actor?.userId ?? null,
            actorDisplaySnapshot: costContext.actor?.display ?? null,
          });
        } else if (cost !== undefined) {
          await this.inventoryService.rememberPurchaseCost(
            manager,
            created.id,
            cost,
          );
        }
        outcome.touchedVariantIds.push(created.id);
        // A variant born retired is a deactivation nobody else will record.
        if (created.isActive === false) {
          outcome.activationChanges.push({
            id: created.id,
            sku: created.sku,
            isActive: false,
          });
        }
        continue;
      }

      // ---- UPDATE / DEACTIVATE -------------------------------------------
      await this.assertVariantBelongsToProduct(manager, productId, dto.id);

      // Reloaded WITH attributeValues: TypeORM can only diff a many-to-many
      // it has actually loaded. Assigning a new array onto an entity whose
      // relation was never hydrated appends the new rows and leaves the old
      // junction rows behind.
      const existing = await variantRepo.findOneOrFail({
        where: { id: dto.id },
        relations: { attributeValues: true },
      });

      if (dto.stock !== undefined) {
        throw new BadRequestException(
          ProductMessages.VARIANT_STOCK_NOT_UPDATABLE,
        );
      }
      if (dto.purchasePrice !== undefined) {
        throw costingError.badRequest(
          CostingErrorCodes.PURCHASE_COST_NOT_UPDATABLE,
          { field: 'variants[].purchasePrice', variantId: dto.id },
        );
      }
      const wasActive = existing.isActive;

      /*
       * TAKING A VARIANT OFF SALE IS ITS OWN CAPABILITY.
       *
       * `products.activate` and `products.deactivate` were in the catalogue,
       * were offered on the access-control screen as separate tick boxes, and
       * were enforced by NOTHING: variant activation rides inside this route's
       * `variants[]` body, which is guarded only by `products.update`. An
       * owner could therefore create a "catalogue editor" role, deliberately
       * withhold `products.deactivate` — whose own Persian description
       * promises it controls exactly this — and the editor could still pull
       * any product off the storefront and the till. A permission that
       * authorises nothing is worse than an absent one, because the screen
       * says granting it meant something.
       *
       * Checked on the TRANSITION, not on the presence of the field: a client
       * that echoes a variant's current `isActive` back is not deactivating
       * anything, and refusing that would break ordinary saves for a role that
       * legitimately holds only `products.update`.
       */
      if (dto.isActive !== undefined && dto.isActive !== wasActive) {
        assertPermissionsHeld(
          actorPermissions,
          dto.isActive ? 'products.activate' : 'products.deactivate',
        );
      }

      if (dto.price !== undefined) existing.price = dto.price;
      if (dto.sku !== undefined) existing.sku = dto.sku;
      if (dto.variantCode !== undefined) {
        existing.variantCode = this.requireVariantCode(
          dto.variantCode,
          productCode,
        );
      }
      if (dto.isActive !== undefined) existing.isActive = dto.isActive;
      if (dto.attributeValueIds !== undefined) {
        existing.attributeValues = await this.resolveAttributeValues(
          manager,
          dto.attributeValueIds,
        );
      }

      const updated = await variantRepo.save(existing);
      outcome.touchedVariantIds.push(updated.id);
      if (wasActive !== updated.isActive) {
        // The SKU recorded is the one the variant carries AFTER the edit,
        // which is what the catalogue will show from now on.
        outcome.activationChanges.push({
          id: updated.id,
          sku: updated.sku,
          isActive: updated.isActive,
        });
      }
    }

    return outcome;
  }

  /**
   * IMAGE CONTRACT -- see `UpdateProductDto` / `CreateProductDto`.
   * `imageIds` is the complete desired ordered set; index becomes sortOrder;
   * currently-attached images that are absent are deleted.
   */
  private async applyImageContract(
    manager: EntityManager,
    productId: number,
    imageIds: number[],
  ): Promise<string[]> {
    const imageRepo = manager.getRepository(ProductImage);

    if (new Set(imageIds).size !== imageIds.length) {
      throw new BadRequestException(ProductMessages.PRODUCT_IMAGES_DUPLICATED);
    }

    if (imageIds.length) {
      const found = await imageRepo.find({
        where: { id: In(imageIds) },
        relations: { product: true },
      });
      if (found.length !== imageIds.length) {
        throw new NotFoundException(ProductMessages.PRODUCT_IMAGES_NOT_FOUND);
      }
      const stolen = found.filter(
        (img) => img.product && img.product.id !== productId,
      );
      if (stolen.length) {
        throw new BadRequestException(
          ProductMessages.PRODUCT_IMAGE_OWNED_BY_OTHER_PRODUCT,
        );
      }
    }

    /*
     * Detach + delete every currently attached image that is not in the
     * desired set. They are unreachable once detached, so keeping the rows
     * would only leak orphans.
     *
     * THE KEY IS HANDED OVER IN THIS SAME TRANSACTION. A deletion job is
     * INSERTed here, beside the DELETE that destroys the row holding the key,
     * so the two commit or roll back together. Either the image row is gone
     * and a durable instruction to delete its bytes exists, or neither
     * happened — "row gone and key forgotten" is not representable.
     *
     * That replaces returning the keys for the caller to delete after the
     * commit. It looked equivalent and was not: if `DeleteObject` then failed,
     * the key existed only in a local variable, the object stayed in the
     * bucket, and nothing anywhere still knew its name. The log line claiming
     * it "can be swept later" was false — there was no row to sweep from.
     *
     * Object storage is still not contacted inside the transaction, so a
     * product edit commits even while the store is unreachable.
     *
     * A row whose `objectKey` is NULL (written before 0034) contributes
     * nothing: its object is unknown and guessing would risk deleting
     * somebody else's.
     */
    const toRemove = await imageRepo.find({
      where: imageIds.length
        ? { product: { id: productId }, id: Not(In(imageIds)) }
        : { product: { id: productId } },
      select: { id: true, objectKey: true },
    });
    const removedObjectKeys = toRemove
      .map((image) => image.objectKey)
      .filter(
        (key): key is string => typeof key === 'string' && key.length > 0,
      );
    if (toRemove.length) {
      await imageRepo.delete({ id: In(toRemove.map((i) => i.id)) });
    }

    for (const key of removedObjectKeys) {
      await this.objectDeletion.enqueue(
        manager,
        key,
        ObjectDeletionOrigin.DETACHED,
      );
    }

    // Re-parent and persist the explicit ordering.
    for (let index = 0; index < imageIds.length; index++) {
      await imageRepo.update(
        { id: imageIds[index] },
        { product: { id: productId } as Product, sortOrder: index },
      );
    }

    return removedObjectKeys;
  }

  /**
   * Try to delete detached objects immediately, POST-COMMIT.
   *
   * AN ACCELERATOR, NOT THE GUARANTEE. Every key here already has a durable
   * deletion job committed alongside the row that was removed, so a failure
   * costs only latency: the worker retries it with backoff. This exists
   * because the common case succeeds in milliseconds and there is no reason to
   * leave the bytes sitting until the next worker pass.
   *
   * Never throws. The catalogue change the caller asked for has already
   * committed and is correct; reporting a successful edit as a failure because
   * a bucket delete returned 500 would be wrong twice over.
   *
   * On success the job is finalised so the worker does not repeat the work.
   */
  private async discardStoredObjects(keys: string[]): Promise<void> {
    for (const key of keys) {
      const deleted = await this.storage.deleteObject(key).catch(() => false);
      if (deleted) {
        await this.objectDeletion.finaliseByKey(key).catch(() => undefined);
      } else {
        this.logger.warn(
          `Immediate delete of detached object failed (key=${key}). A durable ` +
            `deletion job is already committed for it; the object-deletion ` +
            `worker will retry with backoff.`,
        );
      }
    }
  }

  /** Turn Postgres integrity violations into meaningful 4xx responses. */
  private translatePersistenceError(err: unknown): unknown {
    /*
     * Business-code collisions are translated FIRST and by constraint NAME,
     * not by sniffing the driver's `detail` string. A code clash and a SKU
     * clash are different refusals about different fields, and the form must
     * be able to put each one beside the right input.
     */
    const codeConflict = productCodeConflictOr(err);
    if (codeConflict !== err) return codeConflict;

    const driverCode =
      (err as { code?: string; driverError?: { code?: string } })?.driverError
        ?.code ?? (err as { code?: string })?.code;

    if (driverCode === '23505') {
      const detail =
        (err as { driverError?: { detail?: string } })?.driverError?.detail ??
        '';
      if (detail.includes('sku')) {
        return new ConflictException(
          ProductMessages.VARIANT_SKU_ALREADY_EXISTS,
        );
      }
      return new ConflictException(detail || 'Unique constraint violated');
    }
    return err;
  }
}
