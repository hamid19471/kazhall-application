import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';

import {
  CartChangeMessages,
  CartMessages,
  CartStockMessages,
} from 'src/common/constants/cart.messages';
import { ProductMessages } from 'src/common/constants/product.messages';
import { ReservationReleaseReason } from '../inventory/entities/stock-reservation.entity';
import { VariantInactiveError } from '../inventory/inventory.errors';
import { InventoryMessages } from '../inventory/inventory.messages';
import { deriveAvailability } from '../inventory/availability.projection';
import { InventoryService } from '../inventory/inventory.service';
import { InsufficientStockError } from '../inventory/inventory.types';
import {
  CartItemStatus,
  CartLineChangeCause,
  CartLineChangeReason,
} from './entities/cart-item.entity';
import { CreateCartItemDto } from './dto/create-cart-item.dto';
import { CartLineView } from './dto/cart-view.dto';
import { RealtimeGateway } from 'src/modules/realtime/realtime.gateway';

const PG_UNIQUE_VIOLATION = '23505';

/** Change reasons that are shown to the customer as a notice on `GET /cart`. */
const CUSTOMER_VISIBLE_CHANGE_REASONS: ReadonlySet<string> = new Set<string>([
  ReservationReleaseReason.SOLD_IN_STORE,
  ReservationReleaseReason.RESERVATION_EXPIRED,
  CartLineChangeReason.STOCK_NOT_COUNTED,
]);

interface CartLineRow {
  id: number;
  userId: number;
  productId: number;
  /** NOT NULL since migration 0013 -- see the class comment. */
  variantId: number;
  quantity: number;
  status: CartItemStatus;
  lastChangeReason: CartLineChangeCause | null;
  lastChangeAt: Date | null;
  lastChangeQtyDelta: number | null;
  createdAt: Date;
}

/**
 * Basket writes and POS writes must use compatible locking, so every method
 * here goes through InventoryService and respects the same global lock order:
 *
 *     product_variants (ASC id)  ->  stock_reservations  ->  cart_items
 *
 * That is what stops a multi-SKU checkout deadlocking against a multi-SKU POS
 * sale, and what makes "the POS sale and the basket edit cannot both win the
 * same unit" true rather than hopeful.
 *
 * ---------------------------------------------------------------------------
 * ONE KIND OF BASKET LINE (the bypass this file used to contain).
 *
 * Every method below assumes `line.variantId` is a real, sellable variant, and
 * migration 0013 makes the column NOT NULL so that assumption cannot be broken
 * by data. That replaces an explicit `variantId === null` branch that used to
 * run in `create()`, `updateQuantity()`, `remove()` and `findAll()` and that
 * skipped `lockVariants`, skipped `reserveForBasket` and just wrote a quantity,
 * on the grounds that "stock is not tracked at product level".
 *
 * The consequence of that branch was that a product with no variant row could
 * be added to any number of baskets in any quantity, took part in NO
 * availability check, got NO four-hour hold, could not be displaced by a POS
 * sale, and reached checkout with nothing allocated. Migration 0012 gives every
 * option-less product a DEFAULT variant so there is exactly one kind of
 * sellable thing, and `resolveTarget` below is the only place that turns a
 * client's (productId, variantId?) pair into it.
 */
@Injectable()
export class CartService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly inventoryService: InventoryService,
    /**
     * OWNER DECISION: a basket change invalidates storefront availability.
     *
     * Taking, growing, shrinking or dropping a hold moves `availableForBasket`
     * for every other shopper — it is the ONLY way the last buyable unit
     * disappears without a sale — and this service announced none of it. A
     * customer watching a product page saw it stay "available" until they
     * tried to add it.
     *
     * It deliberately does NOT announce a STOCK change, because none happened:
     * a hold moves no physical units, and POS outranks basket holds, so the
     * till's sellable number is untouched. `publishAvailabilityInvalidation`
     * routes the `reservation` reason to the storefront only.
     */
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  /**
   * Post-commit, advisory, never throws (the publisher swallows its own
   * failures). Called after the transaction resolves so a rolled-back basket
   * write cannot announce a hold that does not exist.
   */
  private async publishReservationChange(
    variantIds: readonly number[],
  ): Promise<void> {
    await this.realtimeGateway.publishAvailabilityInvalidation(
      variantIds,
      'reservation',
    );
  }

  // ==========================================================================
  // Write paths
  // ==========================================================================

  /**
   * Add units to the basket.
   *
   * The reservation is taken inside the same transaction as the basket write,
   * so a line can never exist without the stock behind it. R4: the added units
   * become a NEW tranche with their own 4h TTL -- adding to a line never
   * extends the timer on the units that were already there.
   */
  async create(dto: CreateCartItemDto, userId: number): Promise<CartLineView> {
    if (dto.quantity <= 0) {
      throw new BadRequestException(CartMessages.QUANTITY_MUST_BE_POSITIVE);
    }

    // A mutable array rather than a hoisted `let`: the assignment happens
    // inside a callback, which TypeScript's control-flow analysis cannot see,
    // so a nullable local would narrow to `null` after the await.
    const touched: number[] = [];

    const view = await this.withUniqueViolationRetry(() =>
      this.dataSource.transaction(async (manager) => {
        const { productId, variantId } = await this.resolveTarget(
          manager,
          dto.productId,
          dto.variantId ?? null,
        );
        touched.push(variantId);

        // Lock the variant FIRST -- global lock order. Unconditional: there is
        // no longer a class of basket line that skips the lock.
        await this.inventoryService.lockVariants(manager, [variantId]);

        const line = await this.findOrCreateActiveLine(
          manager,
          userId,
          productId,
          variantId,
        );

        const reservation = await this.reserveOrTranslate(manager, {
          userId,
          cartItemId: line.id,
          variantId,
          quantity: dto.quantity,
        });

        await this.setLineQuantity(
          manager,
          line.id,
          reservation.reservedQuantity,
        );
        return this.buildView(
          manager,
          { ...line, quantity: reservation.reservedQuantity },
          reservation,
        );
      }),
    );

    await this.publishReservationChange(touched);
    return view;
  }

  /**
   * Set an absolute quantity on a line.
   *
   * Increase  => a NEW tranche with its own TTL (R4).
   * Decrease  => release NEWEST tranche first, so the units that survive are
   *              the oldest ones and the hold is never silently extended.
   * Unchanged => a pure read. Nothing is written, no timer moves.
   */
  async updateQuantity(
    cartItemId: number,
    quantity: number,
    userId: number,
  ): Promise<CartLineView | null> {
    if (quantity < 0) {
      throw new BadRequestException(CartMessages.QUANTITY_MUST_BE_POSITIVE);
    }
    if (quantity === 0) {
      await this.remove(cartItemId, userId);
      return null;
    }

    // Pushed to only in the branches that actually WRITE. The unchanged case
    // is a pure read (R4: it must not move `expiresAt`), so it announces
    // nothing — an advisory frame for a no-op would send every storefront to
    // re-read a number that did not move.
    const touched: number[] = [];

    const view = await this.dataSource.transaction(async (manager) => {
      const preview = await this.loadOwnedLine(manager, cartItemId, userId);
      await this.inventoryService.lockVariants(manager, [preview.variantId]);
      // Re-read under the variant lock so the quantity we diff against is the
      // one that is actually current.
      const line = await this.loadOwnedLine(manager, cartItemId, userId, true);

      const current = await this.inventoryService.describeBasketLine(
        manager,
        line.id,
        line.variantId,
      );

      if (quantity > current.reservedQuantity) {
        touched.push(line.variantId);
        const reservation = await this.reserveOrTranslate(manager, {
          userId,
          cartItemId: line.id,
          variantId: line.variantId,
          quantity: quantity - current.reservedQuantity,
        });
        await this.setLineQuantity(
          manager,
          line.id,
          reservation.reservedQuantity,
        );
        return this.buildView(
          manager,
          { ...line, quantity: reservation.reservedQuantity },
          reservation,
        );
      }

      if (quantity < current.reservedQuantity) {
        touched.push(line.variantId);
        await this.inventoryService.releaseBasketQuantity(manager, {
          cartItemId: line.id,
          quantity: current.reservedQuantity - quantity,
          reason: ReservationReleaseReason.QUANTITY_REDUCED,
        });
        const after = await this.inventoryService.describeBasketLine(
          manager,
          line.id,
          line.variantId,
        );
        return this.buildView(
          manager,
          { ...line, quantity: after.reservedQuantity },
          after,
        );
      }

      // R4: an identical repeated request is a read. It writes nothing and it
      // must not move `expiresAt` by so much as a millisecond.
      return this.buildView(manager, line, current);
    });

    await this.publishReservationChange(touched);
    return view;
  }

  /** Removing a line releases its reservations exactly once (R3 guarantees it). */
  async remove(cartItemId: number, userId: number): Promise<void> {
    const touched: number[] = [];
    await this.dataSource.transaction(async (manager) => {
      const preview = await this.loadOwnedLine(manager, cartItemId, userId);
      touched.push(preview.variantId);
      await this.inventoryService.lockVariants(manager, [preview.variantId]);
      const line = await this.loadOwnedLine(manager, cartItemId, userId, true);

      // Every ACTIVE reservation on the line leaves ACTIVE via the guarded
      // conditional UPDATE of R3, so a double DELETE releases nothing twice.
      await this.inventoryService.releaseBasketLine(manager, {
        cartItemId: line.id,
        reason: ReservationReleaseReason.BASKET_ITEM_REMOVED,
      });

      // A customer-initiated removal leaves nothing to explain, so the row goes
      // rather than becoming a tombstone.
      await manager.query(`DELETE FROM cart_items WHERE id = $1`, [line.id]);
    });

    await this.publishReservationChange(touched);
  }

  // ==========================================================================
  // Read path -- the recovery path for a missed realtime event
  // ==========================================================================

  /**
   * GET /cart.
   *
   * R7: realtime notifications are advisory. A customer whose websocket dropped
   * during a POS displacement must still see the correction here, which is why
   * this read
   *   (a) lazily expires due reservations (R5) before reporting anything,
   *   (b) reports SERVER-AUTHORITATIVE reserved/available quantities and
   *       `expiresAt`, never a client-remembered value,
   *   (c) surfaces `lastChangeReason` for lines changed by displacement/expiry,
   *   (d) includes soft-removed lines once, so a line that vanished is
   *       explained rather than just missing.
   *
   * It is a read: no `expiresAt` anywhere is touched (R4).
   *
   * PRIVACY: the projection below is the whole response. It carries no staff
   * identity, no branch, no other customer's data -- only what happened to
   * THIS customer's line and why.
   */
  async findAll(userId: number): Promise<{
    items: CartLineView[];
    notices: CartLineView[];
  }> {
    return this.dataSource.transaction(async (manager) => {
      const variantRows: Array<{ variantId: number }> = await manager.query(
        `SELECT DISTINCT "variantId"
           FROM cart_items
          WHERE "userId" = $1
            AND status = 'active'`,
        [userId],
      );
      const variantIds = variantRows.map((r) => Number(r.variantId));

      if (variantIds.length > 0) {
        // (a) Lock then lazily expire, so a hold that ran out while the
        // customer was away is already gone from the numbers below.
        await this.inventoryService.lockVariants(manager, variantIds);
        await this.inventoryService.expireDueReservations(manager, {
          variantIds,
        });
      }

      const rows = await this.selectLines(
        manager,
        `WHERE "userId" = $1
           AND (status = 'active'
                OR (status = 'removed' AND "lastChangeReason" IS NOT NULL))
         ORDER BY "createdAt" DESC, id DESC`,
        [userId],
      );

      const views: CartLineView[] = [];
      for (const row of rows) {
        const reservation = await this.inventoryService.describeBasketLine(
          manager,
          row.id,
          row.variantId,
        );
        views.push(await this.buildView(manager, row, reservation));
      }

      // (d) A soft-removed line is shown exactly once. Clearing the reason
      // keeps the tombstone (so the partial unique index still lets the
      // customer re-add the product) without repeating the notice forever.
      const shownTombstones = rows
        .filter((r) => r.status === CartItemStatus.REMOVED)
        .map((r) => r.id);
      if (shownTombstones.length > 0) {
        await manager.query(
          `UPDATE cart_items
              SET "lastChangeReason" = NULL
            WHERE id = ANY($1::int[])
              AND status = 'removed'`,
          [shownTombstones],
        );
      }

      return {
        items: views.filter((v) => v.status === CartItemStatus.ACTIVE),
        notices: views.filter((v) => v.change !== null),
      };
    });
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  /**
   * Resolves a client's (productId, variantId?) pair to exactly one SELLABLE
   * variant, or refuses.
   *
   * This is the ONLY entry point into the basket, and it always yields a
   * variant id. It used to return `variantId: null` for a product that had no
   * variant rows at all, and every caller then took a branch that skipped
   * locking and reservation -- that was the inventory bypass. Migration 0012
   * gives every option-less product a DEFAULT variant, so the "no sellable
   * unit" case is now a genuine refusal rather than a free pass.
   *
   * The four outcomes:
   *
   *   no such product                -> 404
   *   no ACTIVE variant at all       -> 400 PRODUCT_NOT_SELLABLE
   *                                     (fully retired; NOT the same as
   *                                     out-of-stock, which is a live variant
   *                                     with stock 0 and is sellable-in-
   *                                     principle -- the availability check
   *                                     downstream is what refuses that)
   *   variant omitted, default exists-> the default variant
   *   variant omitted, options exist -> 400 VARIANT_REQUIRED_FOR_PRODUCT
   *
   * A named variant must belong to the product (400, never 404: answering 404
   * would tell an attacker which variant ids exist) and must be active.
   *
   * Deliberately raw SQL against exactly the columns this needs, rather than
   * `manager.findOne(Product, { relations: { variants: true } })`: the catalog
   * entities are workstream B's and gain columns on their own schedule, and an
   * entity/migration skew there must not be able to break the basket.
   */
  private async resolveTarget(
    manager: EntityManager,
    productId: number,
    requestedVariantId: number | null,
  ): Promise<{ productId: number; variantId: number }> {
    const products: Array<{ id: number; visibleOnSite: boolean }> =
      await manager.query(
        `SELECT id, "visibleOnSite" FROM products WHERE id = $1`,
        [productId],
      );
    if (products.length === 0) {
      throw new NotFoundException(ProductMessages.PRODUCT_NOT_FOUND);
    }

    /*
     * THE WEBSITE CHANNEL GATE, on the way IN to the basket.
     *
     * 404, matching `GET /products/:id` for the same product. A customer who
     * cannot see a product on the site must not be able to learn it exists by
     * POSTing its id and reading a different refusal — 403 or a bespoke 400
     * would both confirm the row, turning the basket into an enumeration
     * oracle for the private catalogue.
     *
     * A line already in the basket when the product is withdrawn is handled
     * separately, and deliberately differently: it STAYS, carrying the
     * `channel_unavailable` reason, so the customer is told why rather than
     * finding the row silently gone. See `buildView`.
     */
    if (products[0].visibleOnSite !== true) {
      throw new NotFoundException(ProductMessages.PRODUCT_NOT_FOUND);
    }

    const variants: Array<{
      id: number;
      isActive: boolean;
      isDefault: boolean;
    }> = await manager.query(
      `SELECT id, "isActive", "isDefault"
         FROM product_variants
        WHERE "productId" = $1
        ORDER BY id ASC`,
      [productId],
    );
    const sellable = variants.filter((v) => v.isActive);

    if (requestedVariantId === null) {
      if (sellable.length === 0) {
        throw new BadRequestException(CartMessages.PRODUCT_NOT_SELLABLE);
      }
      const fallback = sellable.find((v) => v.isDefault);
      if (!fallback) {
        // The product is sold BY option. Picking one on the customer's behalf
        // would put a colour or a size they never chose into their basket.
        throw new BadRequestException(
          CartMessages.VARIANT_REQUIRED_FOR_PRODUCT,
        );
      }
      return { productId, variantId: Number(fallback.id) };
    }

    const requested = variants.find(
      (v) => Number(v.id) === Number(requestedVariantId),
    );
    if (!requested) {
      throw new BadRequestException(CartMessages.VARIANT_NOT_PART_OF_PRODUCT);
    }
    if (!requested.isActive) {
      // Retired variants still resolve by id so order history renders, but
      // they are not sellable and must never re-enter a basket.
      throw new BadRequestException(ProductMessages.VARIANT_INACTIVE);
    }
    return { productId, variantId: Number(requested.id) };
  }

  private async selectLines(
    manager: EntityManager,
    whereClause: string,
    params: unknown[],
  ): Promise<CartLineRow[]> {
    const rows: CartLineRow[] = await manager.query(
      `SELECT id, "userId", "productId", "variantId", quantity, status,
              "lastChangeReason", "lastChangeAt", "lastChangeQtyDelta", "createdAt"
         FROM cart_items
         ${whereClause}`,
      params,
    );
    return rows.map((r) => ({
      ...r,
      id: Number(r.id),
      userId: Number(r.userId),
      productId: Number(r.productId),
      variantId: Number(r.variantId),
      quantity: Number(r.quantity),
      lastChangeQtyDelta:
        r.lastChangeQtyDelta === null ? null : Number(r.lastChangeQtyDelta),
    }));
  }

  private async findOrCreateActiveLine(
    manager: EntityManager,
    userId: number,
    productId: number,
    variantId: number,
  ): Promise<CartLineRow> {
    // No NULL-variant special case any more: `variantId` is NOT NULL (0013),
    // so plain equality is total and `uq_cart_items_active_line` really does
    // guarantee one active line per (user, product, variant).
    const existing = await this.selectLines(
      manager,
      `WHERE "userId" = $1
         AND "productId" = $2
         AND "variantId" = $3
         AND status = 'active'
       ORDER BY id ASC
         FOR UPDATE`,
      [userId, productId, variantId],
    );
    if (existing.length > 0) return existing[0];

    const inserted: Array<{ id: number; createdAt: Date }> =
      await manager.query(
        `INSERT INTO cart_items
         ("userId", "productId", "variantId", quantity, status, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 0, 'active', now(), now())
       RETURNING id, "createdAt"`,
        [userId, productId, variantId],
      );

    return {
      id: Number(inserted[0].id),
      userId,
      productId,
      variantId,
      quantity: 0,
      status: CartItemStatus.ACTIVE,
      lastChangeReason: null,
      lastChangeAt: null,
      lastChangeQtyDelta: null,
      createdAt: new Date(inserted[0].createdAt),
    };
  }

  private async loadOwnedLine(
    manager: EntityManager,
    cartItemId: number,
    userId: number,
    lock = false,
  ): Promise<CartLineRow> {
    const rows = await this.selectLines(
      manager,
      `WHERE id = $1 AND "userId" = $2 AND status = 'active'${
        lock ? ' FOR UPDATE' : ''
      }`,
      [cartItemId, userId],
    );
    if (rows.length === 0) {
      throw new NotFoundException(CartMessages.CART_ITEM_NOT_FOUND);
    }
    return rows[0];
  }

  /**
   * Writes the line quantity and clears any stale change notice -- the customer
   * has now acted on the line themselves, so the old explanation is spent.
   */
  private async setLineQuantity(
    manager: EntityManager,
    cartItemId: number,
    quantity: number,
  ): Promise<void> {
    await manager.query(
      `UPDATE cart_items
          SET quantity = $2,
              "lastChangeReason" = NULL,
              "lastChangeAt" = NULL,
              "lastChangeQtyDelta" = NULL,
              "updatedAt" = now()
        WHERE id = $1
          AND status = 'active'`,
      [cartItemId, quantity],
    );
  }

  /**
   * Turns the inventory layer's domain errors into customer-safe HTTP errors.
   *
   * `InsufficientStockError` -> 400 with this customer's request and the
   * aggregate availability, never who is holding the rest.
   *
   * `VariantInactiveError` -> 409 with the SAME stable code the till gets from
   * `POST /orders/pos`, because it is the same refusal: the SKU is retired and
   * may not be sold through any channel.
   *
   * WHY THIS SECOND BRANCH HAD TO BE ADDED. `reserveForBasket` now refuses a
   * retired variant under the row lock, and this method previously re-threw
   * anything that was not an `InsufficientStockError` untouched -- so the new
   * refusal would have left the basket routes as a bare 500. It is reachable
   * from `PATCH /cart/:id` in particular: that path never re-resolves the
   * variant (the basket line is loaded by id), so a line added while the SKU
   * was active is exactly how a customer arrives at the gate.
   */
  private async reserveOrTranslate(
    manager: EntityManager,
    input: {
      userId: number;
      cartItemId: number;
      variantId: number;
      quantity: number;
    },
  ) {
    try {
      return await this.inventoryService.reserveForBasket(manager, input);
    } catch (error) {
      if (error instanceof InsufficientStockError) {
        throw new BadRequestException(
          CartStockMessages.notEnough(error.available, error.requested),
        );
      }
      if (error instanceof VariantInactiveError) {
        throw new ConflictException({
          error: VariantInactiveError.CODE,
          code: VariantInactiveError.CODE,
          message: InventoryMessages.VARIANT_INACTIVE,
          // The customer's own line, and nothing else. No stock number, no
          // reservation detail, no other basket.
          variantId: error.variantId,
          retryable: false,
        });
      }
      throw error;
    }
  }

  private async buildView(
    manager: EntityManager,
    row: CartLineRow,
    // Never null any more: every line has a variant, so every line has a
    // server-authoritative reservation description.
    reservation: {
      reservedQuantity: number;
      expiresAt: Date;
      tranches: Array<{ quantity: number; expiresAt: Date }>;
    },
  ): Promise<CartLineView> {
    // Raw SQL for the same reason as resolveTarget: the basket must not break
    // when workstream B adds a column to a catalog entity ahead of a migration.
    const products: Array<{ title: string }> = await manager.query(
      `SELECT title FROM products WHERE id = $1`,
      [row.productId],
    );
    const images: Array<{ url: string }> = await manager.query(
      `SELECT url FROM product_images WHERE "productId" = $1 ORDER BY "sortOrder" NULLS LAST, id ASC`,
      [row.productId],
    );

    const snapshot = (
      await this.inventoryService.getAvailability(manager, [row.variantId])
    ).get(row.variantId);
    /*
     * `availableForBasket` here answers "how many more units could this
     * customer still add?", so it is the SELLABILITY figure and not the raw
     * one. `getAvailability` is deliberately `isActive`-blind (an administrator
     * reconciling shelf stock needs the true number), which meant a retired SKU
     * reported a positive figure on the basket screen and the quantity stepper
     * invited an increase the server refuses with `VARIANT_INACTIVE`.
     *
     * `deriveAvailability` is the one function that answers sellability, and it
     * returns 0 for a retired variant. Same rule, same place, as every other
     * surface — see docs/ARCHITECTURE.md §7.
     */
    const availableForBasket = snapshot
      ? deriveAvailability(snapshot).availableForBasket
      : null;

    /*
     * THE EFFECTIVE PRICE, not the raw column.
     *
     * `product_variants.price` is NULLABLE and null means "inherit the
     * product's basePrice" -- that is what OrdersService charges at checkout
     * (`cart.variant?.price ?? basePrice`). Reading the raw column and
     * coercing with `?? 0` turned every inherited-price line into a FREE
     * item on the basket screen. COALESCE applies the same inheritance the
     * order path applies, so the basket quotes what the order will charge.
     *
     * The attribute values come along so the basket can name the thing the
     * customer actually chose ("رنگ: مشکی") instead of only its SKU.
     */
    /*
     * The variant's CURRENT activation, read in the same statement as its
     * price. `false` when the row exists and is retired; stays `false` when the
     * row is missing entirely, which the change below treats as "not retired"
     * so a deleted variant keeps following the existing safe fallback contract
     * (`variant: null` plus whatever reason the line already carries) rather
     * than being explained as a deactivation.
     */
    let variantIsActive = false;
    /** Is the product still offered on the WEBSITE? (migration 0030) */
    let productVisibleOnSite = false;
    let variant: {
      id: number;
      sku: string;
      price: number | null;
      attributeValues: Array<{
        id: number;
        value: string;
        attribute?: { id: number; name: string };
      }>;
    } | null = null;
    const variantRows: Array<{
      id: number;
      sku: string;
      variantCode: string | null;
      price: string | number | null;
      isActive: boolean | null;
      visibleOnSite: boolean | null;
    }> = await manager.query(
      `SELECT v.id AS id,
              v.sku AS sku,
              v."variantCode" AS "variantCode",
              COALESCE(v.price, p."basePrice") AS price,
              v."isActive" AS "isActive",
              p."visibleOnSite" AS "visibleOnSite"
         FROM product_variants v
         JOIN products p ON p.id = v."productId"
        WHERE v.id = $1`,
      [row.variantId],
    );
    if (variantRows.length > 0) {
      const attributeRows: Array<{
        id: number;
        value: string;
        attributeId: number | null;
        attributeName: string | null;
      }> = await manager.query(
        `SELECT av.id AS id,
                av.value AS value,
                a.id AS "attributeId",
                a.name AS "attributeName"
           FROM variant_product_attribute_value vav
           JOIN product_attribute_value av ON av.id = vav."productAttributeValueId"
           LEFT JOIN product_attribute a ON a.id = av."attributeId"
          WHERE vav."productVariantsId" = $1
          ORDER BY a.id NULLS LAST, av.id`,
        [row.variantId],
      );
      variantIsActive = variantRows[0].isActive === true;
      productVisibleOnSite = variantRows[0].visibleOnSite === true;
      variant = {
        id: Number(variantRows[0].id),
        sku: variantRows[0].sku,
        // Integer Rial, same unit as products.basePrice -- see migration 0012.
        price:
          variantRows[0].price === null ? null : Number(variantRows[0].price),
        attributeValues: attributeRows.map((a) => ({
          id: Number(a.id),
          value: a.value,
          ...(a.attributeId !== null && a.attributeName !== null
            ? {
                attribute: { id: Number(a.attributeId), name: a.attributeName },
              }
            : {}),
        })),
      };
    }

    /*
     * A RETIRED SKU OUTRANKS THE RECORDED REASON.
     *
     * Deactivation writes nothing to this line: no reservation is released, no
     * quantity moves, no price moves, `lastChangeReason` stays as it was. So it
     * is DERIVED here, per read, from the variant's current `isActive` — the
     * same fact `assertSellableUnderLock` will refuse the order on.
     *
     * It takes precedence over a persisted reason because it answers a
     * different and more useful question. "Your hold expired" or "some units
     * were sold in store" explains how the line SHRANK, and invites the
     * customer to add the item again — which the inventory gate refuses with
     * `VARIANT_INACTIVE`. "This can no longer be sold" is the only reason that
     * tells them what to do. See the matching precedence in
     * `OrdersService.kindOfDisappearance`.
     *
     * When the variant is active the recorded reason stands untouched, so
     * reactivating a SKU does not rewrite the history of a line that really
     * did expire — and does not restore its reservation either.
     *
     * `at` and `quantityDelta` are null on purpose: nothing happened at a
     * particular instant and no units were taken away. A delta of 0 would
     * render as "0 units were removed", which is not what happened.
     */
    const variantRetired = variantRows.length > 0 && variantIsActive !== true;

    /*
     * WITHDRAWN FROM THE WEBSITE — derived exactly like `variantRetired`, and
     * for the same reason: unpublishing writes nothing to this line. No
     * reservation is released, no quantity moves, `lastChangeReason` is
     * untouched, so the fact has to be read per request from the product row.
     *
     * A SEPARATE REASON FROM `not_sellable`, deliberately. `not_sellable`
     * means the SKU is deactivated and cannot be sold anywhere; this means the
     * product is no longer offered ON THE SITE while possibly still selling
     * briskly over the counter. Telling the customer it is discontinued would
     * be false, and it would erase the distinction this feature exists to draw.
     *
     * PRECEDENCE: a retired SKU still outranks it. If the variant is
     * deactivated the product cannot be sold through ANY channel, which is the
     * broader and more useful statement; saying "not on the website" about
     * something that is not sellable at all would understate the problem.
     */
    const channelUnavailable =
      variantRows.length > 0 &&
      !variantRetired &&
      productVisibleOnSite !== true;

    const reason = row.lastChangeReason;
    const change = variantRetired
      ? {
          reason: CartLineChangeReason.NOT_SELLABLE,
          message: CartChangeMessages.not_sellable,
          at: null,
          quantityDelta: null,
        }
      : channelUnavailable
        ? {
            reason: CartLineChangeReason.CHANNEL_UNAVAILABLE,
            message: CartChangeMessages.channel_unavailable,
            // Null for the same reason as `not_sellable`: nothing happened at
            // a particular instant and no units were taken away.
            at: null,
            quantityDelta: null,
          }
        : reason !== null && CUSTOMER_VISIBLE_CHANGE_REASONS.has(reason)
          ? {
              reason,
              message:
                CartChangeMessages[reason as keyof typeof CartChangeMessages],
              at: row.lastChangeAt,
              quantityDelta: row.lastChangeQtyDelta,
            }
          : null;

    return {
      id: row.id,
      status: row.status,
      productId: row.productId,
      productTitle: products[0]?.title ?? null,
      productImages: images.map((i) => i.url),
      variant,
      quantity: row.quantity,
      reservedQuantity: reservation.reservedQuantity,
      availableForBasket,
      // Server-authoritative: the earliest tranche expiry, i.e. the moment the
      // line first starts losing units. Never a client-supplied value.
      expiresAt: reservation.tranches.length > 0 ? reservation.expiresAt : null,
      tranches: reservation.tranches,
      change,
    };
  }

  /**
   * Two concurrent adds of the same product can both miss the SELECT and both
   * INSERT, colliding on the partial unique index. That is a benign race: retry
   * once and the second attempt finds the row the first one created.
   */
  private async withUniqueViolationRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const driverCode = (error as QueryFailedError & { code?: string })?.code;
      const nested = (
        error as QueryFailedError & { driverError?: { code?: string } }
      )?.driverError?.code;
      if (
        driverCode === PG_UNIQUE_VIOLATION ||
        nested === PG_UNIQUE_VIOLATION
      ) {
        return fn();
      }
      throw error;
    }
  }
}
