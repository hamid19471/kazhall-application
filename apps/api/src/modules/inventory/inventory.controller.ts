import {
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  Req,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { DataSource } from 'typeorm';

import { ACCESS_TOKEN_SECURITY_SCHEME } from 'src/configs/swagger.config';
import { AvailabilityQueryDto } from './dto/availability-query.dto';
import { PosCatalogQueryDto } from './dto/pos-catalog-query.dto';
import { SkuLookupDto } from './dto/sku-lookup.dto';
import { InventoryMessages } from './inventory.messages';
import { InventoryService } from './inventory.service';
import { PosCatalogService } from './pos-catalog.service';
import { ReservationSweeperService } from './reservation-sweeper.service';
import { Audiences } from 'src/modules/auth/decorators/audience.decorator';
import { UserRequest } from 'src/common/interfaces/user-request.interface';
import {
  BranchErrorCodes,
  BranchMessages,
} from 'src/common/constants/branch.messages';
import { OrderMessages } from 'src/common/constants/order.messages';
import { RequirePermissions } from 'src/modules/auth/permissions/permission.decorator';

@ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
@ApiTags('Inventory management')
@Controller('inventory')
@Audiences('pos', 'admin')
export class InventoryController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly inventory: InventoryService,
    private readonly catalog: PosCatalogService,
    private readonly sweeper: ReservationSweeperService,
  ) {}

  /**
   * THE TILL'S CATALOGUE. The cashier browses, searches and filters; they do
   * not type a code.
   *
   * WHY IT IS HERE AND NOT ON `/products`. `GET /products` is `@Public()` and
   * the figure a till must show is `availableForPos`, which must not be
   * readable anonymously. That endpoint also returns no variant ids, so a till
   * built on it would fetch each product's detail separately — one request per
   * tile, on every keystroke. This returns a page of products WITH their active
   * variants, effective prices and live `availableForPos` in one request.
   *
   * Availability is INDICATIVE. `POST /orders/pos` re-checks under the variant
   * lock and may still refuse with `INSUFFICIENT_STOCK`.
   */
  @ApiOperation({
    summary: 'Browse, search and filter the sellable catalogue (POS till)',
    description:
      'Paginated. `search` matches a product TITLE, a variant SKU or a variant ' +
      'ATTRIBUTE VALUE, case-insensitively — `GET /products` searches titles ' +
      'only, which is not enough for a counter. `categoryId` filters by one ' +
      'category id from `GET /categories`; the category list is flat.\n\n' +
      'Only ACTIVE variants are returned, and a product with no active variant ' +
      'is omitted entirely. Each variant carries its SKU, its EFFECTIVE price ' +
      '(its own, else the product base price) and `availableForPos`.\n\n' +
      'Availability is INDICATIVE, not a hold.',
  })
  @ApiQuery({ name: 'search', required: false, example: 'کوله' })
  @ApiQuery({ name: 'categoryId', required: false, example: 2 })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 24 })
  @RequirePermissions('pos.access')
  @Get('catalog')
  async catalogue(@Req() req: UserRequest, @Query() query: PosCatalogQueryDto) {
    const branchId = await this.resolveBranchScope(req);
    return this.catalog.browse(query, branchId);
  }

  /**
   * The cashier's branch, asserted to exist and to be OPEN.
   *
   * Every till read goes through this, so "which shop am I standing in" has
   * one answer and one refusal. The id comes from `req.user.branch`, which
   * `JwtStrategy` fills from the DATABASE row on this request — never from a
   * token claim the caller shaped.
   *
   * A caller with NO branch is refused rather than shown everything. That
   * matters most for the `admin` audience, which this controller also serves:
   * without this, an admin session would browse the entire catalogue through
   * the till endpoint and the branch gate would be one URL away from
   * irrelevant.
   *
   * A DEACTIVATED branch is refused rather than returning an empty grid,
   * because an empty grid is indistinguishable from a shop that stocks
   * nothing, and a cashier would go looking for the missing products instead
   * of calling their manager.
   */
  private async resolveBranchScope(req: UserRequest): Promise<number | null> {
    const branchId = req.user?.branch;

    if (branchId === null || branchId === undefined) {
      /*
       * NO BRANCH. What happens next depends on WHICH SURFACE is asking, and
       * the difference is deliberate.
       *
       * A `pos` session with no branch is a MISCONFIGURED CASHIER. There is no
       * set of products "available in their branch", so there is no correct
       * catalogue to return: the full one would be exactly the bypass this
       * feature exists to close, and an empty one is indistinguishable from a
       * shop that stocks nothing. It is refused with the SAME error
       * `POST /orders/pos` already gives such a cashier, so browsing and
       * selling now agree about who may operate a till.
       *
       * BEHAVIOUR CHANGE, STATED PLAINLY: a branchless cashier used to be able
       * to browse the whole catalogue and merely fail at the point of sale.
       * That is no longer true, and the integration fixtures that relied on it
       * were given branches.
       *
       * An `admin` session with no branch is NOT a cashier and is not scoped.
       * It is refused nothing here because it is entitled to the entire
       * catalogue through `GET /products/admin` already — gating this one
       * route would hide nothing while breaking administrative use of the till
       * endpoints. This is not a hole in the branch gate: the gate exists to
       * stop one BRANCH seeing another branch's range, and an administrator
       * has no branch to be confined to.
       */
      if (req.user?.audience === 'admin') return null;
      throw new BadRequestException(OrderMessages.USER_NOT_IN_BRANCH);
    }

    const rows: Array<{ isActive: boolean }> = await this.dataSource.query(
      `SELECT "isActive" FROM "branches" WHERE "id" = $1`,
      [branchId],
    );

    const branch = rows[0];
    if (branch === undefined) {
      throw new BadRequestException(BranchMessages.BRANCH_NOT_FOUND);
    }
    if (!branch.isActive) {
      throw new ConflictException({
        error: BranchErrorCodes.BRANCH_INACTIVE,
        message: BranchMessages.BRANCH_INACTIVE,
        branchId,
      });
    }
    return branchId;
  }

  /**
   * TILL LOOKUP. The cashier scans or types a SKU and gets the sellable unit,
   * its price and its live availability.
   *
   * WHY IT EXISTS. Nothing else in the API let a cashier do this. `GET
   * /products` searches product TITLES only, so a scanned barcode matched
   * nothing, and every endpoint carrying a stock number is `super_admin` — so
   * the `sale` role could not see stock anywhere. A till cannot work without
   * both, and inventory visibility is an owner requirement.
   *
   * It is a pure read of facts the accepted contracts already define. It
   * reserves nothing: a POS sale takes its units at `POST /orders/pos`, under
   * the locks, and `availableForPos` here is INDICATIVE — it can change between
   * this call and the sale.
   */
  @ApiOperation({
    summary: 'Look up a sellable SKU with its live availability (POS till)',
    description:
      'Exact SKU match on `product_variants.sku`, which is globally unique. ' +
      'Returns the product title, the variant, its INTEGER RIAL unit price and ' +
      'an availability snapshot.\n\n' +
      'Availability is INDICATIVE, not a hold — nothing is reserved here. The ' +
      'authoritative check happens inside `POST /orders/pos`, which may still ' +
      'refuse with `INSUFFICIENT_STOCK` or `VARIANT_INACTIVE`.\n\n' +
      '`availableForPos` (= physicalStock − orderAllocated) is the RAW number, ' +
      'and a till may show it: a POS sale may take units from ecommerce ' +
      'baskets, but never from stock already allocated to a paid online ' +
      'order.\n\n' +
      'THE RAW NUMBER IS NOT AN AUTHORISATION TO SELL. Read `sellableInStore` ' +
      'for that, and `unsellableReason` for why not. Raw physical ' +
      'availability remains visible for inventory management, but ' +
      '`isActive = false` makes the variant unsellable through both ' +
      'Storefront and POS — so a retired SKU with fifty units in the ' +
      'stockroom reports `availableForPos: 50`, `sellableInStore: false`, ' +
      '`unsellableReason: "variant_inactive"`, and `POST /orders/pos` ' +
      'refuses it with a 409 `VARIANT_INACTIVE`.\n\n' +
      'A deactivated variant is still returned, with `isActive: false`, so the ' +
      'till can say "this SKU is retired" instead of "unknown SKU", and its ' +
      'true shelf quantity stays visible for stock reconciliation.',
  })
  @ApiQuery({ name: 'sku', required: true, example: 'IPH17-BLK-128' })
  @RequirePermissions('pos.access')
  @Get('lookup')
  async lookup(@Req() req: UserRequest, @Query() query: SkuLookupDto) {
    const branchId = await this.resolveBranchScope(req);
    const found = await this.dataSource.transaction((manager) =>
      this.inventory.lookupBySku(manager, query.sku.trim(), branchId),
    );
    if (!found) {
      throw new NotFoundException(InventoryMessages.VARIANT_NOT_FOUND);
    }
    return { data: found };
  }

  /**
   * Batch availability for a basket of lines the till already knows about.
   *
   * Same indicative caveat as `/inventory/lookup`.
   *
   * AN UNKNOWN VARIANT ID FAILS THE WHOLE REQUEST with 404, naming the missing
   * ids. That is the existing inventory contract, not a choice made here:
   * `computeAvailability` throws for ids it cannot resolve, and `lockVariants`
   * does the same, because every consuming path (checkout, POS) must fail loudly
   * rather than silently price a basket it could not fully resolve. A till only
   * ever sends ids it got from `/inventory/lookup`, so a 404 here means a stale
   * client cache or a deleted variant — both worth surfacing.
   */
  @ApiOperation({
    summary: 'Live availability for up to 100 variants (POS / admin)',
    description:
      'INDICATIVE, not a hold.\n\n' +
      'An unknown variant id fails the WHOLE request with 404 naming the ' +
      'missing ids — the same rule every other inventory read follows. Send ' +
      'only ids obtained from `/inventory/lookup` or the catalog.\n\n' +
      'The four quantities are never interchangeable: `physicalStock` is what ' +
      'is on the shelf, `basketReserved` is held by ecommerce baskets, ' +
      '`orderAllocated` is held by paid online orders, ' +
      '`availableForBasket` = physicalStock − basketReserved − orderAllocated, ' +
      'and `availableForPos` = physicalStock − orderAllocated. The gap between ' +
      'the last two is exactly what a POS sale may take from baskets.\n\n' +
      'EVERY ROW ALSO CARRIES `isActive`, and it must be combined with the ' +
      'quantities before a client treats a line as sellable: the quantities ' +
      'are raw, so a RETIRED variant reports its true shelf stock and a ' +
      'positive `availableForPos` while being sellable nowhere. Raw physical ' +
      'availability remains visible for inventory management, but ' +
      '`isActive = false` makes the variant unsellable through both ' +
      'Storefront and POS, and `POST /orders/pos` enforces that under a row ' +
      'lock with a 409 `VARIANT_INACTIVE`.',
  })
  @RequirePermissions('pos.access')
  @Get('availability')
  async availability(@Query() query: AvailabilityQueryDto) {
    const snapshots = await this.dataSource.transaction((manager) =>
      this.inventory.getAvailability(manager, query.variantIds),
    );
    return { data: [...snapshots.values()] };
  }

  /**
   * Manual, deterministic trigger for the expiry sweeper.
   *
   * The background timer is an optimisation only (correctness is R5 lazy
   * expiry), but an explicit trigger lets an operator drain a backlog and lets
   * the test suite run a sweep at an exact point in time instead of waiting on
   * a timer.
   */
  @ApiOperation({ summary: 'Run one bounded expired-reservation sweep' })
  /*
   * `inventory.adjust`, not `pos.access`: this releases expired holds and
   * therefore CHANGES what is available to sell, while the three reads above
   * only look. They are gated on `pos.access` because they ARE the till's
   * catalogue — the console reads stock through `/admin/inventory`, which
   * needs `inventory.read`. Both built-in roles that could reach these before
   * (`sale`, `super_admin`) hold `pos.access`, so the conversion is
   * behaviour-preserving; what it removes is the last route in the admin
   * surface whose authorisation was a role NAME.
   */
  @RequirePermissions('inventory.adjust')
  @HttpCode(200)
  @Post('admin/sweep-reservations')
  async sweep() {
    const result = await this.sweeper.runOnce();
    return {
      data: {
        batches: result.batches,
        releasedReservations: result.releasedReservations,
        affectedBasketLines: result.affectedBasketLines.length,
        prunedCartTombstones: result.prunedCartTombstones,
      },
    };
  }
}
