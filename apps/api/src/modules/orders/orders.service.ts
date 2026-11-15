import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateStatusOrderDto } from './dto/update-status-order.dto';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Order, OrderAddressSnapshot } from './entities/order.entity';
import {
  DataSource,
  EntityManager,
  In,
  IsNull,
  Not,
  Repository,
} from 'typeorm';
import { OrderItems } from './entities/order-item.entity';
import { OrderAction, OrderActionType } from './entities/order-action.entity';
import { UserService } from 'src/modules/user/user.service';
import { AddressService } from 'src/modules/address/address.service';
import { OrderStatusEnum } from './enums/order-status.enum';
import {
  CartItem,
  CartItemStatus,
  CartLineChangeReason,
} from '../cart/entities/cart-item.entity';
import { ProductVariant } from '../products/entities/product-variant.entity';
import { OrderChannel } from './enums/order-channel.enum';
import { PaymentMethodEnum } from './enums/payment-method.enum';
import {
  FulfillmentStateEnum,
  canAdvancePastPaid,
} from './enums/fulfillment-state.enum';
import { CreatePosOrderDto } from './dto/create-pos-order.dto';
import { ReverseOrderDto } from './dto/reverse-order.dto';
import {
  CustomerOrderListView,
  CustomerOrderView,
  toCustomerOrderListView,
  toCustomerOrderView,
} from './dto/customer-order.view';
import { CustomerService } from '../customer/customer.service';
import {
  OrderErrorCode,
  OrderMessages,
  RECONCILIATION_QUEUE_PATH,
} from 'src/common/constants/order.messages';
import {
  BranchErrorCodes,
  BranchMessages,
} from 'src/common/constants/branch.messages';
import { CartChangeMessages } from 'src/common/constants/cart.messages';
import {
  CheckoutChangeKind,
  CheckoutConflictCode,
  CheckoutMessages,
} from 'src/common/constants/checkout.messages';
import { ReservationReleaseReason } from '../inventory/entities/stock-reservation.entity';
import { UserMessages } from 'src/common/constants/user.messages';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { Branch } from '../branch/entities/branch.entity';
import { User } from '../user/entities/user.entity';
import { Payment } from '../payment/entities/payment.entity';
import { PaymentStatusEnum } from '../payment/enums/payment-status-enum';
import { InventoryService } from '../inventory/inventory.service';
import {
  ConsumedVariantResult,
  InsufficientStockError,
  PosConsumeItem,
} from '../inventory/inventory.types';
import {
  ConcurrentModificationError,
  ProductNotAvailableInBranchError,
  VariantInactiveError,
} from '../inventory/inventory.errors';
import { ProductVisibilityService } from '../products/services/product-visibility.service';
import { InventoryMessages } from '../inventory/inventory.messages';
import { StockMovementReason } from '../inventory/entities/stock-movement.entity';
import { IdempotencyScope } from 'src/common/entities/idempotency-key.entity';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IdempotentReplayError,
  claimIdempotencyKey,
  completeIdempotencyKey,
  peekIdempotencyKey,
  requestHashOf,
} from './idempotency.helper';
import {
  allowedNextOrderStatuses,
  canTransitionOrderStatus,
  isPostPaymentOperationalStatus,
} from './order-status.machine';
import { resolveReportTimezone } from './business-time';
import { buildOrderNumber } from './order-number';
import {
  CheckoutQuoteLine,
  CheckoutQuotePayload,
  CheckoutQuoteService,
  IssuedCheckoutQuote,
  QuoteVerification,
} from './checkout-quote.service';
import { lineTotalRial, sumLineTotalsRial } from 'src/common/money/rial';

// ===========================================================================
// CHECKOUT CONTRACT
// ===========================================================================

/** Customer-facing text for each change kind. Says WHAT, never WHO. */
export const CHECKOUT_CHANGE_MESSAGES: Record<CheckoutChangeKind, string> = {
  [CheckoutChangeKind.CHANNEL_UNAVAILABLE]:
    'This product is no longer offered on the website and cannot be ordered here',
  [CheckoutChangeKind.SOLD_IN_STORE]: CartChangeMessages.sold_in_store,
  [CheckoutChangeKind.RESERVATION_EXPIRED]:
    CartChangeMessages.reservation_expired,
  [CheckoutChangeKind.NOT_SELLABLE]: CheckoutMessages.LINE_NOT_SELLABLE,
  [CheckoutChangeKind.STOCK_NOT_COUNTED]: CartChangeMessages.stock_not_counted,
  [CheckoutChangeKind.PRICE_CHANGED]: CheckoutMessages.PRICE_CHANGED,
  [CheckoutChangeKind.LINE_ADDED]:
    'This item was added to your basket after you reviewed your order',
  [CheckoutChangeKind.QUANTITY_CHANGED]:
    'The quantity of this item changed after you reviewed your order',
  [CheckoutChangeKind.TOTAL_CHANGED]:
    'The total changed after you reviewed your order',
};

/**
 * MACHINE-READABLE CODES FOR AN INVENTORY REFUSAL.
 *
 * Carried in BOTH `error` (which `GlobalExceptionFilter` promotes to the top
 * level of the body) and `code` (which lands in `details`), so a client can
 * read `body.error ?? body.details?.code` the way it already does for the
 * checkout conflicts. They are the ONLY thing a client should branch on: the
 * `message` is human text and is expected to be translated and reworded.
 *
 * Deliberately screaming-snake like `IDEMPOTENCY_KEY_REUSED` rather than
 * lowercase like `checkout_quote_stale`: these are refusals about the WORLD
 * (stock), not about the checkout handshake.
 */
export const InventoryConflictCode = {
  /**
   * The cashier's branch does not carry this product (migration 0030).
   *
   * A SEPARATE code from `VARIANT_INACTIVE` on purpose: the variant may be
   * active, in stock and selling briskly at the branch next door. Collapsing
   * the two would tell a cashier a product is discontinued when it is merely
   * not carried here, and would erase the distinction this whole feature
   * exists to draw.
   */
  PRODUCT_NOT_AVAILABLE_IN_BRANCH: ProductNotAvailableInBranchError.CODE,
  /** Fewer units exist than were asked for. `details` names the shortfall. */
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  /** A guarded stock/reservation update lost a race; nothing was applied. */
  INVENTORY_CONCURRENTLY_MODIFIED: 'INVENTORY_CONCURRENTLY_MODIFIED',
  /**
   * The variant is deactivated, so it may not be sold through any channel --
   * however many units are physically on the shelf.
   *
   * NOT `INSUFFICIENT_STOCK`, and the distinction matters to a client: the
   * shortfall code is retryable with a smaller quantity, this one is not
   * retryable at all until an administrator reactivates the SKU. `details`
   * therefore carries `retryable: false`.
   */
  VARIANT_INACTIVE: VariantInactiveError.CODE,
} as const;

export type InventoryConflictCode =
  (typeof InventoryConflictCode)[keyof typeof InventoryConflictCode];

/** Mirrors the charset in idempotency.helper.ts; see requireCheckoutIdempotencyKey. */
const CHECKOUT_KEY_CHARSET = /^[A-Za-z0-9._:-]+$/;

/** One difference between the basket the customer saw and the one on the server. */
export interface CheckoutChange {
  cartItemId: number | null;
  productId: number | null;
  variantId: number | null;
  productTitle: string | null;
  kind: CheckoutChangeKind;
  previousQuantity: number | null;
  currentQuantity: number | null;
  previousUnitPrice: number | null;
  currentUnitPrice: number | null;
  /**
   * Populated only for `TOTAL_CHANGED`, where the figures being compared are
   * basket totals and not per-unit prices. Carrying them in the `unitPrice`
   * fields (as an earlier version did) made a frontend render "the unit price
   * changed from 200,000 to 360,000" for a two-unit basket.
   */
  previousTotal?: number | null;
  currentTotal?: number | null;
  message: string;
}

export interface CheckoutLineResponse {
  id: number;
  productId: number | null;
  variantId: number | null;
  productTitleSnapshot: string;
  variantSkuSnapshot: string | null;
  attributesSnapshot: Record<string, string> | null;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

export interface CheckoutResponse {
  id: number;
  orderNumber: string | null;
  status: OrderStatusEnum;
  fulfillmentState: FulfillmentStateEnum;
  paymentMethod: PaymentMethodEnum | null;
  soldAt: string;
  subtotal: number;
  totalPrice: number;
  address: OrderAddressSnapshot | null;
  items: CheckoutLineResponse[];
  /** The server-issued quote this order was authorised by. */
  acceptedQuote: {
    basketVersion: string;
    issuedAt: string;
    expiresAt: string;
    subtotal: number;
    total: number;
  };
}

/** One basket line priced under the inventory locks. */
export interface PurchasableLine {
  line: CartItem;
  /** Non-null: a line without a sellable SKU never becomes purchasable. */
  variantId: number;
  quantity: number;
  unitPrice: number;
  /**
   * `product_variants.isActive` AS READ UNDER THE ROW LOCK that priced this
   * line — the same locked row the price came from, and the same value
   * `InventoryService.assertSellableUnderLock` will refuse the sale on.
   *
   * WHY IT IS CARRIED HERE. A retired SKU is the one basket change that leaves
   * no trace on the line itself: nothing releases its reservation, nothing
   * writes `lastChangeReason`, its quantity does not move and its price does
   * not move. Read from anywhere but the locked row it is a guess; read from
   * the line it is invisible. So the projection carries it forward from the
   * only place it is authoritative, and `collectNotices` turns it into the one
   * change kind that describes it (`NOT_SELLABLE`).
   *
   * The line stays PURCHASABLE when this is false, deliberately: excluding it
   * would make the checkout fail as a stale quote, and the authoritative
   * refusal for this condition is `409 VARIANT_INACTIVE` from the inventory
   * gate. The customer is told why; the server still refuses.
   */
  variantIsActive: boolean;

  /**
   * Is the product still offered on the WEBSITE? (migration 0030)
   *
   * Like `variantIsActive`, a false value leaves the line PURCHASABLE so the
   * customer gets a diff explaining it rather than an opaque stale-quote
   * failure. Unlike `variantIsActive`, there is no inventory gate that will
   * refuse it later — nothing about stock is wrong — so `checkout()` carries
   * an EXPLICIT refusal for this condition. Without that the basket would
   * describe the problem and then happily sell the item anyway.
   */
  productVisibleOnSite: boolean;
}

export interface PricedBasket {
  /**
   * The instant the locked decision was made — read AFTER `lockVariants`
   * returned, so it accounts for however long that lock was contended. Every
   * expiry decision and the order's own `soldAt` are taken from this.
   */
  at: Date;
  purchasable: PurchasableLine[];
  subtotal: number;
  /** Informational explanations; they never block checkout. */
  notices: CheckoutChange[];
}

export interface CheckoutQuoteView {
  /** Send this back as `quoteToken` to place the order. */
  token: string;
  /** Digest of the priced lines and totals this quote is bound to. */
  basketVersion: string;
  issuedAt: string;
  expiresAt: string;
  subtotal: number;
  total: number;
}

export interface CheckoutBasketView {
  lines: Array<{
    cartItemId: number;
    productId: number | null;
    variantId: number | null;
    productTitle: string | null;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>;
  subtotal: number;
  total: number;
}

export interface CheckoutQuoteResponse {
  quote: CheckoutQuoteView;
  basket: CheckoutBasketView;
  notices: CheckoutChange[];
}

/** The authenticated principal. NEVER built from a request body. */
export interface OrderActor {
  userId: number;
  branchId: number | null;
}

export interface PosSaleLineResponse {
  id: number;
  variantId: number | null;
  productId: number | null;
  productTitleSnapshot: string;
  variantSkuSnapshot: string | null;
  attributesSnapshot: Record<string, string> | null;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

export interface PosSaleResponse {
  id: number;
  orderNumber: string | null;
  channel: OrderChannel;
  status: OrderStatusEnum;
  fulfillmentState: FulfillmentStateEnum;
  paymentMethod: PaymentMethodEnum | null;
  soldAt: string;
  voidedAt: string | null;
  branchId: number | null;
  branchNameSnapshot: string | null;
  cashierUserId: number | null;
  cashierDisplaySnapshot: string | null;
  customerId: number | null;
  subtotal: number;
  totalPrice: number;
  items: PosSaleLineResponse[];
  stock: Array<{
    variantId: number;
    quantityConsumed: number;
    balanceAfter: number;
    fromFreeStock: number;
    fromDisplacedBaskets: number;
  }>;
  displacedBasketLines: number;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private readonly timezone: string;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    private readonly userService: UserService,
    private readonly addressService: AddressService,
    private readonly customerService: CustomerService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly configService: ConfigService,
    // Injected by class token: workstream D's InventoryModule exports
    // InventoryService and every method composes into our transaction.
    private readonly inventory: InventoryService,
    private readonly quoteService: CheckoutQuoteService,
    /*
     * The SAME service the Admin write path uses. A second implementation of
     * "may this be sold here" in this module is precisely how two surfaces end
     * up disagreeing about one question.
     */
    private readonly productVisibility: ProductVisibilityService,
  ) {
    this.timezone = resolveReportTimezone(
      this.configService.get<string>('REPORT_TIMEZONE'),
    );
  }

  // =====================================================================
  // Online checkout
  // =====================================================================

  async create(
    createOrderDto: CreateOrderDto,
    userId: number,
    idempotencyKey: string,
  ): Promise<CheckoutResponse> {
    const key = this.requireCheckoutIdempotencyKey(idempotencyKey);

    /**
     * The hash covers WHAT IS BEING ORDERED, not which quote authorised it.
     *
     * `quoteToken` is a control field for the SAME logical checkout attempt:
     * every rejection rolls its transaction back (taking the key claim with
     * it), so the client resubmits the same attempt with the same key and the
     * FRESH token it was just handed. Including the token in the hash would
     * make that legitimate resubmission look like key reuse with a different
     * body and answer it with a 409 the customer could never get past.
     *
     * (The comment here used to name `confirmChanges` and `expectedTotal`, the
     * fields the signed quote replaced. They are no longer accepted at all.)
     */
    const requestHash = requestHashOf({
      scope: 'online_order',
      userId,
      address: createOrderDto.address,
      discount_code: createOrderDto.discount_code ?? null,
    });

    // Fast path: an already-completed identical request never opens a write
    // transaction at all.
    const replay = await peekIdempotencyKey(
      this.dataSource.manager,
      IdempotencyScope.ONLINE_ORDER,
      key,
      requestHash,
    );
    if (replay) return replay.responseBody as CheckoutResponse;

    /*
     * Variants whose availability the checkout moved, announced after commit.
     *
     * Checkout is not a no-op for availability even though physical stock does
     * not move: the customer's basket holds become ORDER allocations, and an
     * allocation is subtracted from BOTH channels while a basket hold is
     * subtracted only from the storefront. It can also top up from free stock
     * when displacement had shrunk the hold. So the till's sellable number
     * really does change here — hence `allocation`, which reaches staff too,
     * and not `reservation`.
     *
     * This path announced nothing at all before: a customer completing
     * checkout silently removed units from every other shopper's view.
     */
    const allocated: number[] = [];

    try {
      const result = await this.dataSource.transaction(async (manager) => {
        const claim = await claimIdempotencyKey(
          manager,
          IdempotencyScope.ONLINE_ORDER,
          key,
          requestHash,
        );

        /**
         * INVENTORY DOMAIN ERRORS BECOME 409s HERE, NOT 500s.
         *
         * `checkout` drives `InventoryService` twice — `priceBasketUnderLock`
         * (lockVariants + lazy expiry) and `convertBasketToOrderAllocation`,
         * the checkout boundary — and neither had a translation, so an
         * `InsufficientStockError` raised while converting the customer's
         * basket hold into an order allocation escaped as a bare 500. It is
         * reachable: an admin stock adjustment with `allowBelowReserved` can
         * leave a live basket reservation with no physical stock behind it, and
         * the quote gate cannot see that (it prices RESERVATIONS, which are
         * unchanged, so the basket fingerprint still matches).
         *
         * WHY THE CATCH IS HERE, INSIDE THE TRANSACTION, AND WHY THAT IS SAFE:
         *
         *  - It wraps exactly one call — the whole checkout body — so a single
         *    `translateInventoryError` covers both inventory entry points
         *    without a second, drifting mapping at either of them.
         *  - It NEVER swallows. `translateInventoryError` returns the original
         *    error unchanged for anything that is not a known domain class, and
         *    the result is always re-thrown, so the transaction always rolls
         *    back and a genuine internal fault stays a 500.
         *  - Throwing from inside `dataSource.transaction` is what rolls the
         *    unit of work back, so nothing is left half-applied: the order row,
         *    its line snapshots, the released basket holds AND the idempotency
         *    claim all disappear together. Rolling the claim back is correct —
         *    the customer may retry with the SAME key, exactly as a refused
         *    confirmation already does.
         *  - It changes no lock ordering. R1 (ascending variantId) lives in
         *    `lockVariants`, which is untouched; this only decides what HTTP
         *    status the already-failed transaction reports.
         */
        let response: CheckoutResponse;
        try {
          response = await this.checkout(
            manager,
            createOrderDto,
            userId,
            allocated,
          );
        } catch (err) {
          throw this.translateInventoryError(err);
        }
        await completeIdempotencyKey(manager, claim, 201, response);
        return response;
      });

      await this.realtimeGateway.publishAvailabilityInvalidation(
        allocated,
        'allocation',
      );
      return result;
    } catch (err) {
      // A concurrent identical request won the claim and has since finished.
      // Hand back ITS response rather than an error: from the customer's point
      // of view the checkout succeeded, which is exactly what happened.
      //
      // A REPLAY announces nothing: the allocation it describes was already
      // announced by the request that actually did the work.
      if (err instanceof IdempotentReplayError) {
        return err.responseBody as CheckoutResponse;
      }
      throw err;
    }
  }

  /**
   * The checkout body. Runs inside the caller's transaction so that the
   * idempotency claim, the order, its line snapshots, the address snapshot and
   * the basket->order allocation conversion all commit together or not at all.
   */
  private async checkout(
    manager: EntityManager,
    dto: CreateOrderDto,
    userId: number,
    /**
     * Collects the variant ids this checkout actually converted from basket
     * holds into order allocations, so the caller can announce them AFTER the
     * commit.
     *
     * Passed in rather than returned because `CheckoutResponse` is the
     * customer's payload and these ids are an internal side-channel; and taken
     * from `allocationItems` rather than from the request DTO because the
     * request does not name items at all — checkout converts whatever is in
     * the basket.
     */
    allocated: number[],
  ): Promise<CheckoutResponse> {
    const orderRepository = manager.getRepository(Order);
    const orderItemRepository = manager.getRepository(OrderItems);
    /**
     * Named for what it is: the instant the REQUEST arrived, before any lock
     * has been requested. It is used for the cheap pre-lock rejection only.
     * The authoritative instant is `at`, read after the lock wait — see below.
     * The previous name (`now`) invited exactly the mistake this fixes: it was
     * threaded into the reservation and expiry checks that run after a wait it
     * predates.
     */
    const requestedAt = new Date();

    const user = await this.userService.findOne(userId);

    /**
     * OWNERSHIP IS ENFORCED IN THE SERVICE, not left to the controller.
     *
     * This used to be `addressService.findOne(dto.address)`, which looks up an
     * address by id and checks nothing else — so any authenticated customer
     * could have an order delivered to any other customer's saved address just
     * by naming a small integer. A missing address and someone else's address
     * are BOTH answered 404, so the endpoint cannot be used to enumerate
     * address ids.
     */
    const address = await this.addressService.findOneOwnedBy(
      dto.address,
      userId,
    );

    // ---- 0. Verify the presented quote's SIGNATURE, EXPIRY and OWNER.
    //
    // Cheap, database-free, and done before anything else so a forged or
    // foreign token never reaches the pricing path. Whether the basket still
    // MATCHES the quote is a fact about the database and is checked in step 3,
    // under the locks.
    const quote = this.quoteService.verify(dto.quoteToken, userId, requestedAt);

    // ---- 1. Price the basket UNDER THE INVENTORY LOCKS.
    //
    // One helper does this for both the quote endpoint and this one, so the
    // prices a customer is shown and the prices they are charged come from the
    // same code reading the same locked rows. Two separate pricing paths is how
    // a review screen and a charge drift apart.
    const priced = await this.priceBasketUnderLock(manager, userId, {
      alsoLockVariantIds: quote.ok
        ? quote.payload.lines.map((line) => line.variantId)
        : [],
    });
    const { purchasable, notices } = priced;

    /**
     * THE LOCKED INSTANT. `now` above was read before `lockVariants` was even
     * requested; `at` is read after it returned. Everything from here on — the
     * quote's window, the order's `soldAt`, the allocation TTL — uses `at`.
     */
    const at = priced.at;

    /**
     * RE-VALIDATE THE QUOTE'S WINDOW AT THE LOCKED INSTANT.
     *
     * Step 0's `verify()` ran before the lock was requested. `lockVariants`
     * BLOCKS, so a quote that was inside its window then can be outside it by
     * the time we own the rows — and the pre-lock pass would have waved it
     * through. Expiry is only meaningful if it is evaluated at the moment the
     * decision is actually made.
     *
     * Folded into the SAME rejection branch as every other unusable quote, so
     * the client gets one consistent, recoverable response (a 409 carrying a
     * fresh quote) whether the token was forged, was already expired, or lapsed
     * while we queued for a lock.
     */
    const acceptedQuote: QuoteVerification =
      quote.ok && this.quoteService.isExpiredAt(quote.payload, at)
        ? {
            ok: false,
            rejection: 'expired',
            detail:
              `expired while checkout waited for the variant lock: expiresAt ` +
              `${new Date(quote.payload.expiresAt).toISOString()}, locked at ${at.toISOString()}`,
          }
        : quote;

    /*
     * ---- 1d. WITHDRAWN FROM THE WEBSITE — refuse, authoritatively.
     *
     * This is the ONE unsellable condition with no inventory gate behind it.
     * A deactivated variant is refused later by `assertSellableUnderLock`
     * (`409 VARIANT_INACTIVE`) and a stock shortfall by the allocation itself,
     * so for those the basket only has to EXPLAIN. Nothing about a withdrawn
     * product is wrong with its stock, so nothing downstream would stop it:
     * without this branch the diff would name the problem and the order would
     * then be placed anyway.
     *
     * Read from the SHARE-LOCKED product row taken in `priceBasketUnderLock`,
     * so an unpublish racing this checkout resolves to a definite outcome.
     *
     * `retryable: false`: only an administrator re-publishing the product
     * changes this, and a client that retries in a loop achieves nothing.
     * `confirmationRequired: false` and NO quote, for the same reason
     * CONTENTS_CHANGED carries none — there is nothing for the customer to
     * approve, the line has to leave the basket first.
     */
    this.assertNothingWithdrawnFromSite(priced);

    // ---- 2. Nothing left to buy. Distinct from an empty basket: the customer
    //         DID have items and is owed the reason they went.
    if (purchasable.length === 0) {
      throw new ConflictException({
        error: CheckoutConflictCode.CONTENTS_CHANGED,
        code: CheckoutConflictCode.CONTENTS_CHANGED,
        message: CheckoutMessages.BASKET_NO_LONGER_AVAILABLE,
        confirmationRequired: false,
        // NO `quote`, and deliberately so: there is nothing purchasable left to
        // price, so no quote can be issued. The client's recovery is to send
        // the customer back to the basket, not to re-confirm. Documented as an
        // exception in docs/CHECKOUT-CONTRACT.md.
        quote: null,
        changes: notices,
        basket: { lines: [], subtotal: 0, total: 0 },
      });
    }

    const subtotal = priced.subtotal;

    // ---- 3. THE CONFIRMATION GATE.
    //
    // An order is placed only against a quote this server issued, that has not
    // expired, that belongs to THIS customer, and that prices EXACTLY the
    // basket which exists right now under the locks.
    //
    // WHAT THIS REPLACED. The gate used to be
    //
    //     if (changes.length > 0 && dto.confirmChanges !== true) { ...409... }
    //
    // so `confirmChanges: true` suppressed changes the server had detected in
    // the very same request — including a mismatch against the `expectedTotal`
    // the client had just sent. Omitting `expectedTotal` achieved the same
    // thing by declaring no expectation at all. Both meant the customer was
    // charged whatever the server computed at that instant, which is precisely
    // what a confirmation step exists to prevent.
    //
    // A boolean was the root cause: it cannot name WHICH basket the customer
    // agreed to buy, so it authorises every later basket equally well. The
    // quote names one.
    if (!acceptedQuote.ok) {
      // `missing` is the ordinary first step of checkout, not a failure: the
      // customer has not been shown their order yet. Everything else is
      // reported with ONE indistinguishable code, with the real reason logged
      // server-side — see CheckoutQuoteService.verify.
      const firstAttempt = acceptedQuote.rejection === 'missing';
      if (!firstAttempt) {
        this.logger.warn(
          `checkout quote refused for user ${userId}: ${acceptedQuote.rejection} ` +
            `(${acceptedQuote.detail})`,
        );
      }

      throw this.quoteConflict({
        userId,
        code: firstAttempt
          ? CheckoutConflictCode.QUOTE_REQUIRED
          : CheckoutConflictCode.QUOTE_INVALID,
        message: firstAttempt
          ? CheckoutMessages.QUOTE_REQUIRED
          : CheckoutMessages.QUOTE_INVALID,
        purchasable,
        subtotal,
        notices,
        changes: notices,
        now: at,
      });
    }

    /**
     * MATERIALITY IS THE FINGERPRINT, not the total.
     *
     * `basketVersion` covers every line's SKU, quantity and unit price plus the
     * totals, so a basket that changed but happens to cost the same — one SKU
     * swapped for another at the same price, one line halved and another
     * doubled — is a MISMATCH and is refused. An `expectedTotal` check could
     * never see that, and a `confirmChanges` boolean did not even try.
     */
    const quotedVersion = CheckoutQuoteService.basketVersion(
      acceptedQuote.payload.lines,
      acceptedQuote.payload.subtotal,
      acceptedQuote.payload.total,
    );
    const currentVersion = CheckoutQuoteService.basketVersion(
      purchasable.map((item) => ({
        variantId: item.variantId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
      subtotal,
      subtotal,
    );

    if (quotedVersion !== currentVersion) {
      throw this.quoteConflict({
        userId,
        code: CheckoutConflictCode.QUOTE_STALE,
        message: CheckoutMessages.QUOTE_STALE,
        purchasable,
        subtotal,
        notices,
        // The precise, line-by-line difference between what the customer
        // accepted and what exists now. This is strictly better than the old
        // notice-driven guess: it names the SKU, both quantities and both
        // prices, so the client can render an exact "was / now" comparison.
        changes: this.diffQuoteAgainstBasket(
          acceptedQuote.payload,
          purchasable,
          subtotal,
          notices,
        ),
        now: at,
      });
    }

    // ---- 4. Place the order.
    const order = orderRepository.create({
      user,
      channel: OrderChannel.ONLINE,
      address,
      addressSnapshot: {
        addressId: address.id,
        province: address.province,
        city: address.city,
        address: address.address,
        postalCode: address.postal_code,
        receiverMobile: address.reciver_mobile,
        capturedAt: at.toISOString(),
      },
      status: OrderStatusEnum.PENDING,
      fulfillmentState: FulfillmentStateEnum.NOT_REQUIRED,
      paymentMethod: PaymentMethodEnum.ONLINE_GATEWAY,
      discount_code: dto.discount_code,
      soldAt: at,
      subtotal,
      total_price: subtotal,
    });
    await orderRepository.save(order);

    order.orderNumber = this.buildOrderNumber(
      OrderChannel.ONLINE,
      order.id,
      at,
    );
    await orderRepository.update(order.id, {
      orderNumber: order.orderNumber,
    });

    const orderItems = purchasable.map((item) =>
      orderItemRepository.create({
        order,
        product: item.line.product,
        variant: item.line.variant ?? null,
        productTitleSnapshot: item.line.product.title,
        variantSkuSnapshot: item.line.variant?.sku ?? null,
        /*
         * The BUSINESS CODES, frozen at sale time (migration 0032).
         *
         * Unlike a SKU, a code is EDITABLE by a super_admin. Without these two
         * columns, correcting a typo in a product code would silently rewrite
         * what every past receipt and report says was sold — which is exactly
         * what the other snapshot columns exist to prevent.
         */
        productCodeSnapshot: item.line.product.productCode ?? null,
        variantCodeSnapshot: item.line.variant?.variantCode ?? null,
        attributesSnapshot: this.attributesOf(item.line.variant),
        quantity: item.quantity,
        unit_price: item.unitPrice,
        // Guarded multiply, not `*`. The DTO bounds make an overflow
        // unreachable for a basket built today; a variant priced before those
        // bounds existed is exactly the case they cannot cover, and a rounded
        // `total_price` here would no longer sum to the `subtotal` the customer
        // accepted in the quote.
        total_price: lineTotalRial(item.unitPrice, item.quantity),
      }),
    );
    await orderItemRepository.save(orderItems);

    /**
     * The checkout boundary of docs/ARCHITECTURE.md §2: the customer's BASKET
     * reservations become ORDER allocations bound to this order, topped up from
     * free stock when displacement or expiry shrank the hold.
     *
     * This also does the basket cleanup. `convertBasketToOrderAllocation` ->
     * `syncAffectedCartLines` soft-removes each converted line with
     * `CONVERTED_TO_ORDER`, which is a USER-INITIATED reason and therefore
     * leaves `lastChangeReason` NULL — the line vanishes from the basket
     * without generating a notice, which is right, because the customer did ask
     * for it.
     *
     * WHAT WE DELIBERATELY NO LONGER DO is `cartRepository.remove(cartItems)`.
     * That hard-deleted EVERY row it had loaded, tombstones included, so the
     * "some of these units were sold in one of our stores" notices the customer
     * had not yet seen were destroyed by the act of checking out — the customer
     * was charged a corrected basket and never told it had been corrected. It
     * also orphaned `stock_reservations."cartItemId"`, which is a plain integer
     * column with no foreign key and so is not cleaned up by a cascade.
     */
    const allocationItems = this.aggregateItems(
      purchasable.map((item) => ({
        // Non-null by construction: `priceBasketUnderLock` skips a line whose
        // `variantId` is null, so it never reaches `purchasable`. (This used to
        // credit a "NOT_SELLABLE branch above" that no longer exists — and
        // `NOT_SELLABLE` now means something else entirely: a line whose SKU
        // was DEACTIVATED, which does stay purchasable so the inventory gate
        // can refuse it with `VARIANT_INACTIVE`.)
        variantId: item.variantId,
        quantity: item.quantity,
      })),
    );
    for (const item of allocationItems) allocated.push(item.variantId);
    await this.inventory.convertBasketToOrderAllocation(manager, {
      userId,
      orderId: order.id,
      items: allocationItems,
      // The locked instant, so the order allocation's TTL is measured from
      // when the decision was actually made and not from before the wait.
      now: at,
    });

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      fulfillmentState: order.fulfillmentState,
      paymentMethod: order.paymentMethod,
      soldAt: at.toISOString(),
      subtotal,
      totalPrice: subtotal,
      address: order.addressSnapshot,
      items: orderItems.map((item) => ({
        id: item.id,
        productId: item.product?.id ?? null,
        variantId: item.variant?.id ?? null,
        productTitleSnapshot: item.productTitleSnapshot,
        variantSkuSnapshot: item.variantSkuSnapshot,
        attributesSnapshot: item.attributesSnapshot,
        quantity: item.quantity,
        unitPrice: item.unit_price,
        totalPrice: item.total_price,
      })),
      /**
       * THE QUOTE THIS ORDER WAS PLACED AGAINST.
       *
       * Echoed so the accepted purchase is visible in the order response and in
       * every idempotent replay of it. `basketVersion` equals the fingerprint
       * of the order's own line snapshots by construction — the order was only
       * created because the two matched — so `order_items` is the durable
       * record of what the customer accepted and this block is the receipt for
       * how it was authorised.
       */
      acceptedQuote: {
        basketVersion: currentVersion,
        issuedAt: new Date(acceptedQuote.payload.issuedAt).toISOString(),
        expiresAt: new Date(acceptedQuote.payload.expiresAt).toISOString(),
        subtotal: acceptedQuote.payload.subtotal,
        total: acceptedQuote.payload.total,
      },
    };
  }

  // =====================================================================
  // Checkout quote
  // =====================================================================

  /**
   * `POST /orders/quote` — price the customer's basket and sign the result.
   *
   * This is the review step. It writes no order, holds no extra stock and takes
   * no idempotency key, because it changes nothing the customer can be charged
   * for. It DOES run inside a transaction and under the inventory locks: lazy
   * expiry (R5) is part of reading settled truth, and a quote priced from an
   * unlocked read could quote a price that a concurrent POS sale had already
   * invalidated.
   */
  /**
   * Refuse if any priced line's product has been withdrawn from the WEBSITE.
   *
   * Called by BOTH `quoteCheckout` and `checkout`, and that is the point: a
   * quote that succeeded here and an order that failed later would tell the
   * customer their basket was fine and then refuse it at the last step. One
   * condition, one refusal, at the first authoritative opportunity.
   *
   * This is the only unsellable condition with no inventory gate behind it. A
   * deactivated variant is refused by `assertSellableUnderLock`
   * (`409 VARIANT_INACTIVE`) and a shortfall by the allocation itself, so for
   * those the basket only has to EXPLAIN. Nothing about a withdrawn product is
   * wrong with its stock, so without this nothing downstream would stop it.
   *
   * `retryable: false` — only an administrator republishing the product
   * changes the answer, and a client retrying in a loop achieves nothing.
   */
  private assertNothingWithdrawnFromSite(priced: PricedBasket): void {
    const withdrawn = priced.purchasable.filter(
      (item) => !item.productVisibleOnSite,
    );
    if (withdrawn.length === 0) return;

    throw new ConflictException({
      error: CheckoutConflictCode.CHANNEL_UNAVAILABLE,
      code: CheckoutConflictCode.CHANNEL_UNAVAILABLE,
      message: CheckoutMessages.CHANNEL_UNAVAILABLE,
      confirmationRequired: false,
      retryable: false,
      quote: null,
      /*
       * SAFE DETAILS ONLY: the customer's own basket lines, so the UI can mark
       * the offending rows. No branch configuration, no mode and no list of
       * shops that still carry the product — a storefront response must never
       * disclose the retail channel's setup.
       */
      lines: withdrawn.map((item) => ({
        cartItemId: item.line.id,
        variantId: item.variantId,
        productTitle: item.line.product?.title ?? null,
      })),
      changes: priced.notices,
    });
  }

  async quoteCheckout(userId: number): Promise<CheckoutQuoteResponse> {
    return this.dataSource.transaction(async (manager) => {
      /**
       * Same translation as `create`, for the same reason: this is the other
       * ecommerce route that drives `InventoryService` (lazy expiry, R5, runs
       * here too), and an untranslated domain error would be a 500. Pricing
       * cannot raise `InsufficientStockError` — it reads reservations rather
       * than asking for stock — so in practice this only covers the guarded-
       * update class; it is here so the two checkout routes cannot diverge.
       */
      let priced: PricedBasket;
      try {
        priced = await this.priceBasketUnderLock(manager, userId);
      } catch (err) {
        throw this.translateInventoryError(err);
      }

      if (priced.purchasable.length === 0) {
        throw new ConflictException({
          error: CheckoutConflictCode.CONTENTS_CHANGED,
          code: CheckoutConflictCode.CONTENTS_CHANGED,
          message: CheckoutMessages.BASKET_NO_LONGER_AVAILABLE,
          confirmationRequired: false,
          changes: priced.notices,
          basket: { lines: [], subtotal: 0, total: 0 },
        });
      }

      // Refused HERE as well as at `POST /orders`, so a quote never promises a
      // basket the order will then refuse.
      this.assertNothingWithdrawnFromSite(priced);

      // Issued from the LOCKED instant, so the validity window starts when the
      // prices were actually read rather than before a contended lock wait.
      const issued = this.issueQuote(
        userId,
        priced.purchasable,
        priced.subtotal,
        priced.at,
      );
      return {
        quote: this.quoteView(issued),
        basket: this.basketView(priced.purchasable, priced.subtotal),
        /**
         * Why the basket may look different from the last time the customer
         * saw it. Informational: these do NOT block checkout, because the quote
         * they are attached to already prices the corrected basket. Reporting
         * them here is what makes the correction visible at the moment the
         * customer accepts it.
         */
        notices: priced.notices,
      };
    });
  }

  /**
   * Loads the customer's ACTIVE basket, locks its variants in the global order
   * (R1), lazily expires due reservations (R5), then prices every line from the
   * LOCKED variant row and the line's ACTUAL active reservations.
   *
   * Shared by the quote endpoint and by checkout so that the numbers a customer
   * reviews and the numbers they are charged are produced by one code path.
   */
  private async priceBasketUnderLock(
    manager: EntityManager,
    userId: number,
    options: { alsoLockVariantIds?: number[] } = {},
  ): Promise<PricedBasket> {
    const cartRepository = manager.getRepository(CartItem);

    // A first, unlocked read exists only to discover WHICH variants to lock.
    const discovered = await this.loadActiveBasket(cartRepository, userId);
    if (discovered.length === 0) {
      throw new BadRequestException(CheckoutMessages.BASKET_EMPTY);
    }

    /**
     * The lock set is the union of what the basket holds now and what the
     * presented quote priced. Including the quote's SKUs matters: a line the
     * customer accepted may have been soft-removed since, and we still have to
     * read its variant under a lock to state authoritatively that it is gone.
     */
    const variantIds = [
      ...new Set(
        [
          ...discovered.map((line) => line.variantId),
          ...(options.alsoLockVariantIds ?? []),
        ].filter((id): id is number => id !== null && id !== undefined),
      ),
    ].sort((a, b) => a - b);

    /*
     * The empty-basket fallback is typed FROM the service, not hand-copied.
     *
     * It used to restate the lock row's shape inline, so when `lockVariants`
     * began returning `isActive` under the lock this branch silently described
     * a narrower row than the one the other branch produces.
     */
    type LockedVariants = Awaited<ReturnType<InventoryService['lockVariants']>>;
    const locked: LockedVariants =
      variantIds.length > 0
        ? await this.inventory.lockVariants(manager, variantIds)
        : (new Map() as LockedVariants);

    /*
     * THE WEBSITE CHANNEL GATE, read under a SHARE lock on the product rows.
     *
     * Same discipline as the POS branch gate: taken AFTER the variant lock and
     * ordered by product id, so an admin unpublishing a product races this
     * checkout to a definite outcome instead of being read stale. `FOR SHARE`
     * rather than `FOR UPDATE` because two customers checking out the same
     * product must not serialise behind one another — only the writer is
     * excluded.
     */
    const siteVisible = new Map<number, boolean>();
    if (variantIds.length > 0) {
      const rows: Array<{ variantId: number; visibleOnSite: boolean }> =
        await manager.query(
          `SELECT v."id" AS "variantId", p."visibleOnSite" AS "visibleOnSite"
             FROM "product_variants" v
             JOIN "products" p ON p."id" = v."productId"
            WHERE v."id" = ANY($1::int[])
            ORDER BY p."id" ASC
              FOR SHARE OF p`,
          [variantIds],
        );
      for (const row of rows) {
        siteVisible.set(Number(row.variantId), row.visibleOnSite === true);
      }
    }

    /**
     * THE AUTHORITATIVE INSTANT, TAKEN AFTER THE LOCK WAIT.
     *
     * `lockVariants` is a plain `SELECT ... FOR UPDATE`, so it BLOCKS: a
     * concurrent POS sale or another checkout holding the same variant row can
     * stall it for as long as that transaction runs. Everything decided from
     * here on — which reservations are still alive, whether the quote is still
     * inside its window, what instant the sale is stamped with — must be
     * decided against a clock read AFTER that wait.
     *
     * It used to be decided against a `now` captured by the caller BEFORE the
     * lock was requested. A basket hold or a quote that expired while we were
     * queued was therefore still treated as live, and the customer was sold
     * units whose 4-hour reservation had already been released to somebody
     * else, or charged against a quote that had already lapsed.
     *
     * NOT PostgreSQL's `now()`: that is the TRANSACTION START timestamp, which
     * is at least as stale as the caller's reading (`clock_timestamp()` is the
     * statement-time equivalent). A JS `new Date()` is used because it is the
     * same clock that writes `stock_reservations."expiresAt"` and the quote's
     * `expiresAt`, so every comparison below is within one clock rather than
     * across two.
     */
    const at = new Date();

    if (variantIds.length > 0) {
      await this.inventory.expireDueReservations(manager, {
        variantIds,
        now: at,
      });
    }

    // Re-read under the lock. Expiry above rewrites `cart_items`, and a
    // concurrent POS sale may have displaced units, so the discovery read is
    // only a statement of intent.
    const lines = await this.loadActiveBasket(cartRepository, userId);

    const purchasable: PurchasableLine[] = [];
    for (const line of lines) {
      // A line with no sellable SKU cannot be stock-checked or reserved, so it
      // is never silently sold. Unreachable for new lines since
      // `cart_items.variantId` became NOT NULL; kept so an older row fails
      // LOUDLY rather than being sold with nothing behind it.
      if (line.variantId === null) continue;

      /**
       * A SKU that appeared after the discovery read is NOT under our lock, so
       * its price and availability cannot be stated authoritatively. Refusing
       * is the honest answer — the alternative is quoting or charging a price
       * we did not read under a lock. In practice this needs the customer to
       * edit their own basket during their own checkout request.
       */
      if (!locked.has(line.variantId)) {
        /**
         * Reported as RETRY_REQUIRED, not CONTENTS_CHANGED. It is a transient
         * race inside one request, not a change the customer has to approve:
         * there is no diff to show them, and no quote can be returned because
         * a basket we could not price authoritatively cannot be priced into a
         * quote. It previously borrowed CONTENTS_CHANGED and returned an empty
         * `changes` and an empty `basket`, which told a client to "show the
         * customer the changes" and handed it nothing to show.
         */
        this.logger.warn(
          `checkout for user ${userId} saw SKU ${line.variantId} appear after the ` +
            `lock set was chosen; refusing rather than pricing it unlocked`,
        );
        throw new ConflictException({
          error: CheckoutConflictCode.RETRY_REQUIRED,
          code: CheckoutConflictCode.RETRY_REQUIRED,
          message: CheckoutMessages.RETRY_REQUIRED,
          confirmationRequired: false,
          retryable: true,
        });
      }

      /**
       * THE AUTHORITATIVE QUANTITY IS THE RESERVED ONE. `cart_items.quantity`
       * is maintained to equal the sum of the line's active basket
       * reservations, but it is a derived cache; the reservations are the holds
       * that actually exist. Anything above them would be sold out of stock
       * nobody is holding.
       */
      const held = await this.inventory.describeBasketLine(
        manager,
        line.id,
        line.variantId,
        at,
      );
      const quantity = Math.min(line.quantity, held.reservedQuantity);
      if (quantity <= 0) continue;

      // Price from the LOCKED variant row. Never from the entity graph loaded
      // before the lock, and never from `products.basePrice`.
      const unitPrice = Number(locked.get(line.variantId)?.price ?? 0);

      purchasable.push({
        line,
        variantId: line.variantId,
        quantity,
        unitPrice,
        // From the SAME locked row as `unitPrice`, never from the entity graph
        // read before the lock.
        variantIsActive: locked.get(line.variantId)?.isActive === true,
        // From the share-locked product row, for the same reason.
        productVisibleOnSite: siteVisible.get(line.variantId) === true,
      });
    }

    /*
     * BigInt fold, not `+=` on doubles. Two line totals can each be exactly
     * representable while their SUM is not, and this subtotal is what the quote
     * is signed over, what `orders.total_price` stores, and what
     * `payment.amount` is derived from — so a silently rounded value here is
     * the figure the customer is charged. It throws rather than rounding: a
     * basket whose total cannot be stated exactly must not become an order.
     */
    const subtotal = sumLineTotalsRial(
      purchasable.map((item) => lineTotalRial(item.unitPrice, item.quantity)),
    );

    return {
      at,
      purchasable,
      subtotal,
      notices: await this.collectNotices(cartRepository, userId, purchasable),
    };
  }

  /**
   * Customer-facing explanations for changes the customer has not been shown
   * yet — a line a POS sale emptied, a hold that expired, a line migration 0013
   * could not carry forward.
   *
   * INFORMATIONAL ONLY. These used to be part of the confirmation gate, which
   * had two problems: a notice on a line whose economics had not changed forced
   * a pointless 409, and `GET /cart` clears the reason for ACTIVE lines nowhere
   * — so such a line could wedge a customer in a permanent 409. Materiality is
   * now the quote fingerprint, which is a statement about prices and quantities
   * rather than about whether a message has been displayed.
   */
  private async collectNotices(
    repository: Repository<CartItem>,
    userId: number,
    purchasable: PurchasableLine[],
  ): Promise<CheckoutChange[]> {
    const notices: CheckoutChange[] = [];

    for (const item of purchasable) {
      /*
       * A RETIRED SKU IS A NOTICE WITH NO TRACE ON THE LINE.
       *
       * Every other reason a basket line differs from what the customer last
       * saw leaves a record on the row: a POS sale or an expiry writes
       * `lastChangeReason` and a negative `lastChangeQtyDelta`, a quantity edit
       * moves `quantity`, a re-price moves the locked price. Deactivating a
       * variant moves NONE of them — the hold is not released, the quantity is
       * untouched, the price is untouched — so this loop's
       * `lastChangeReason === null` skip meant the one change the customer can
       * do nothing about was the one change they were never told about.
       *
       * Checkout then refused with `409 VARIANT_INACTIVE` and no diff, or (if
       * the line had ALSO shrunk for some other reason) explained it as an
       * expired hold, which invites the customer to add it again — and the
       * inventory gate refuses that too.
       *
       * Reported with quantities UNCHANGED (`previousQuantity === currentQuantity`)
       * because nothing was taken away: the units are still held, they simply
       * cannot be bought. That is what distinguishes this notice from every
       * other kind, and it is why it does not need a quantity delta to be
       * meaningful.
       */
      if (!item.variantIsActive) {
        notices.push(
          this.changeOf(
            item.line,
            CheckoutChangeKind.NOT_SELLABLE,
            item.quantity,
            item.quantity,
            item.unitPrice,
          ),
        );
        continue;
      }

      /*
       * Withdrawn from the website. Reported with quantities UNCHANGED for the
       * same reason as `NOT_SELLABLE` directly above: the units are still held,
       * they simply cannot be bought here. A separate kind from NOT_SELLABLE
       * because the variant is active and may still be selling in the shops.
       */
      if (!item.productVisibleOnSite) {
        notices.push(
          this.changeOf(
            item.line,
            CheckoutChangeKind.CHANNEL_UNAVAILABLE,
            item.quantity,
            item.quantity,
            item.unitPrice,
          ),
        );
        continue;
      }

      if (item.line.lastChangeReason === null) continue;
      notices.push(
        this.changeOf(
          item.line,
          this.kindOfDisappearance(item.line),
          // `lastChangeQtyDelta` is negative when units were taken away.
          item.quantity - (item.line.lastChangeQtyDelta ?? 0),
          item.quantity,
          item.unitPrice,
        ),
      );
    }

    for (const tombstone of await this.loadUnshownNotices(repository, userId)) {
      notices.push(
        this.changeOf(
          tombstone,
          this.kindOfDisappearance(tombstone),
          Math.abs(tombstone.lastChangeQtyDelta ?? 0),
          0,
        ),
      );
    }

    return notices;
  }

  /**
   * The line-by-line difference between the basket the customer ACCEPTED and
   * the one that exists now.
   *
   * Reported per SKU rather than per basket row, because the SKU is what the
   * customer chose and what they are charged for. Every branch names both the
   * old and the new figure so a client can render an exact "was / now".
   */
  private diffQuoteAgainstBasket(
    quoted: CheckoutQuotePayload,
    purchasable: PurchasableLine[],
    subtotal: number,
    notices: CheckoutChange[],
  ): CheckoutChange[] {
    const quotedByVariant = new Map(
      quoted.lines.map((line) => [line.variantId, line]),
    );
    const currentByVariant = new Map(
      purchasable.map((item) => [item.variantId, item]),
    );
    // A notice explains WHY a line shrank (sold in store, hold expired). Reuse
    // it where we have one so the diff carries the reason and not just the
    // arithmetic.
    const reasonByVariant = new Map(
      notices
        .filter((notice) => notice.variantId !== null)
        .map((notice) => [notice.variantId as number, notice.kind]),
    );

    const changes: CheckoutChange[] = [];
    const variantIds = [
      ...new Set([...quotedByVariant.keys(), ...currentByVariant.keys()]),
    ].sort((a, b) => a - b);

    for (const variantId of variantIds) {
      const was = quotedByVariant.get(variantId);
      const now = currentByVariant.get(variantId);

      if (was && !now) {
        changes.push(
          this.variantChange({
            variantId,
            kind:
              reasonByVariant.get(variantId) ??
              CheckoutChangeKind.RESERVATION_EXPIRED,
            previousQuantity: was.quantity,
            currentQuantity: 0,
            previousUnitPrice: was.unitPrice,
            currentUnitPrice: null,
          }),
        );
        continue;
      }

      if (!was && now) {
        changes.push(
          this.variantChange({
            variantId,
            kind: CheckoutChangeKind.LINE_ADDED,
            previousQuantity: 0,
            currentQuantity: now.quantity,
            previousUnitPrice: null,
            currentUnitPrice: now.unitPrice,
            productTitle: now.line.product?.title ?? null,
            cartItemId: now.line.id,
            productId: now.line.productId,
          }),
        );
        continue;
      }

      if (!was || !now) continue;

      if (was.quantity !== now.quantity) {
        changes.push(
          this.variantChange({
            variantId,
            kind:
              now.quantity < was.quantity
                ? (reasonByVariant.get(variantId) ??
                  CheckoutChangeKind.RESERVATION_EXPIRED)
                : CheckoutChangeKind.QUANTITY_CHANGED,
            previousQuantity: was.quantity,
            currentQuantity: now.quantity,
            previousUnitPrice: was.unitPrice,
            currentUnitPrice: now.unitPrice,
            productTitle: now.line.product?.title ?? null,
            cartItemId: now.line.id,
            productId: now.line.productId,
          }),
        );
      }

      if (was.unitPrice !== now.unitPrice) {
        changes.push(
          this.variantChange({
            variantId,
            kind: CheckoutChangeKind.PRICE_CHANGED,
            previousQuantity: was.quantity,
            currentQuantity: now.quantity,
            previousUnitPrice: was.unitPrice,
            currentUnitPrice: now.unitPrice,
            productTitle: now.line.product?.title ?? null,
            cartItemId: now.line.id,
            productId: now.line.productId,
          }),
        );
      }
    }

    /**
     * Reported ALONGSIDE the per-line changes, never instead of them. A basket
     * can change materially with the total unmoved — swap one SKU for another
     * at the same price, or halve one line and double another — and a customer
     * told only that the total is unchanged has been told nothing. Conversely a
     * total that moved with no per-line change would mean a rounding or
     * discount bug, and surfacing it is how that gets noticed.
     */
    if (quoted.total !== subtotal) {
      changes.push(
        this.variantChange({
          variantId: null,
          kind: CheckoutChangeKind.TOTAL_CHANGED,
          previousQuantity: null,
          currentQuantity: null,
          previousUnitPrice: null,
          currentUnitPrice: null,
          previousTotal: quoted.total,
          currentTotal: subtotal,
        }),
      );
    }

    return changes;
  }

  private variantChange(input: {
    variantId: number | null;
    kind: CheckoutChangeKind;
    previousQuantity: number | null;
    currentQuantity: number | null;
    previousUnitPrice: number | null;
    currentUnitPrice: number | null;
    previousTotal?: number | null;
    currentTotal?: number | null;
    productTitle?: string | null;
    cartItemId?: number | null;
    productId?: number | null;
  }): CheckoutChange {
    return {
      cartItemId: input.cartItemId ?? null,
      productId: input.productId ?? null,
      variantId: input.variantId,
      productTitle: input.productTitle ?? null,
      kind: input.kind,
      previousQuantity: input.previousQuantity,
      currentQuantity: input.currentQuantity,
      previousUnitPrice: input.previousUnitPrice,
      currentUnitPrice: input.currentUnitPrice,
      previousTotal: input.previousTotal ?? null,
      currentTotal: input.currentTotal ?? null,
      message: CHECKOUT_CHANGE_MESSAGES[input.kind],
    };
  }

  private issueQuote(
    userId: number,
    purchasable: PurchasableLine[],
    subtotal: number,
    now: Date,
  ): IssuedCheckoutQuote {
    const lines: CheckoutQuoteLine[] = purchasable.map((item) => ({
      variantId: item.variantId,
      cartItemId: item.line.id,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      // The quote is SIGNED over these figures and later compared field by
      // field against a re-price, so a rounded line total here would be
      // faithfully re-signed and the mismatch would never surface.
      totalPrice: lineTotalRial(item.unitPrice, item.quantity),
    }));
    return this.quoteService.issue({
      userId,
      lines,
      subtotal,
      total: subtotal,
      now,
    });
  }

  /**
   * Every refusal of a confirmation carries a FRESH quote for the basket as it
   * stands, so a client is always one round trip from progressing and never has
   * to guess what to send next.
   *
   * The transaction this is thrown from ROLLS BACK, which is the point: no
   * order, no order allocation, no idempotency claim and no basket mutation
   * survive a rejected confirmation, so the customer may retry with the same
   * `Idempotency-Key`.
   */
  private quoteConflict(input: {
    userId: number;
    code: CheckoutConflictCode;
    message: string;
    purchasable: PurchasableLine[];
    subtotal: number;
    notices: CheckoutChange[];
    changes: CheckoutChange[];
    now: Date;
  }): ConflictException {
    const issued = this.issueQuote(
      input.userId,
      input.purchasable,
      input.subtotal,
      input.now,
    );

    return new ConflictException({
      error: input.code,
      code: input.code,
      message: input.message,
      confirmationRequired: true,
      howToConfirm:
        'Show `basket` and `changes` to the customer. When they accept, resend ' +
        'this request with `quoteToken` set to `quote.token` and the SAME ' +
        'Idempotency-Key.',
      quote: this.quoteView(issued),
      changes: input.changes,
      notices: input.notices,
      basket: this.basketView(input.purchasable, input.subtotal),
    });
  }

  private quoteView(issued: IssuedCheckoutQuote): CheckoutQuoteView {
    return {
      token: issued.token,
      basketVersion: issued.basketVersion,
      issuedAt: new Date(issued.payload.issuedAt).toISOString(),
      expiresAt: new Date(issued.payload.expiresAt).toISOString(),
      subtotal: issued.payload.subtotal,
      total: issued.payload.total,
    };
  }

  private basketView(
    purchasable: PurchasableLine[],
    subtotal: number,
  ): CheckoutBasketView {
    return {
      lines: purchasable.map((item) => ({
        cartItemId: item.line.id,
        productId: item.line.productId,
        variantId: item.variantId,
        productTitle: item.line.product?.title ?? null,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.unitPrice * item.quantity,
      })),
      subtotal,
      total: subtotal,
    };
  }

  // ---- checkout helpers ---------------------------------------------------

  /** Active basket lines only, with everything the snapshots need. */
  private loadActiveBasket(
    repository: Repository<CartItem>,
    userId: number,
  ): Promise<CartItem[]> {
    return repository.find({
      where: { userId, status: CartItemStatus.ACTIVE },
      relations: {
        product: true,
        variant: { attributeValues: { attribute: true } },
      },
      order: { id: 'ASC' },
    });
  }

  /**
   * Soft-removed lines whose explanation the customer has NOT been shown yet.
   * `GET /cart` clears `lastChangeReason` once it has displayed the notice, so
   * a non-null reason here means "changed since they last looked".
   */
  private loadUnshownNotices(
    repository: Repository<CartItem>,
    userId: number,
  ): Promise<CartItem[]> {
    return repository.find({
      where: {
        userId,
        status: CartItemStatus.REMOVED,
        lastChangeReason: Not(IsNull()),
      },
      relations: { product: true },
      order: { id: 'ASC' },
    });
  }

  /**
   * Maps the reservation-release reason recorded on the line to a customer-
   * facing change kind. PRIVACY: `sold_in_store` says a store sold the units
   * and never which store, which cashier, or to whom.
   *
   * IT DOES NOT DECIDE `NOT_SELLABLE`, and must not learn to. This function
   * answers "what HAPPENED to this line?" from the record the line carries;
   * `NOT_SELLABLE` answers "can this line be bought at all?" from the variant's
   * current, row-locked state. `collectNotices` asks the second question first
   * and returns early, so the two never compete for one line:
   *
   *   - variant retired  -> `NOT_SELLABLE`, whatever the recorded reason says.
   *     A line that cannot be bought is not usefully explained by how it
   *     shrank, and telling a customer their hold expired invites them to add
   *     it again — which `assertSellableUnderLock` refuses.
   *   - variant active    -> the recorded reason stands, exactly as before.
   *     Reactivating a SKU therefore does NOT rewrite the reason of a line
   *     that genuinely expired, and does not restore its reservation.
   *
   * `RESERVATION_EXPIRED` stays reserved for a hold that actually ran out (or
   * for an untracked disappearance, per `default:`), and `SOLD_IN_STORE` stays
   * reserved for POS displacement.
   */
  private kindOfDisappearance(line: CartItem): CheckoutChangeKind {
    switch (line.lastChangeReason) {
      case ReservationReleaseReason.SOLD_IN_STORE:
        return CheckoutChangeKind.SOLD_IN_STORE;
      case ReservationReleaseReason.RESERVATION_EXPIRED:
        return CheckoutChangeKind.RESERVATION_EXPIRED;
      case CartLineChangeReason.STOCK_NOT_COUNTED:
        // Written by migration 0013 to a line that never had a reservation at
        // all. Without this case it fell to `default:` and was explained as
        // "your 4-hour hold expired" -- untrue, because no hold ever existed
        // for it. Nothing about money or stock was at risk; the customer was
        // simply told the wrong reason.
        return CheckoutChangeKind.STOCK_NOT_COUNTED;
      default:
        // No recorded reason: the hold is simply not there any more. Reported
        // as an expiry, which is what an untracked disappearance amounts to
        // from the customer's side, rather than guessing at a store sale.
        return CheckoutChangeKind.RESERVATION_EXPIRED;
    }
  }

  private changeOf(
    line: CartItem,
    kind: CheckoutChangeKind,
    previousQuantity: number,
    currentQuantity: number,
    unitPrice: number | null = null,
  ): CheckoutChange {
    return {
      cartItemId: line.id,
      productId: line.productId,
      variantId: line.variantId,
      productTitle: line.product?.title ?? null,
      kind,
      previousQuantity,
      currentQuantity,
      previousUnitPrice: null,
      currentUnitPrice: unitPrice,
      message: CHECKOUT_CHANGE_MESSAGES[kind],
    };
  }

  /**
   * Mirrors `requirePosIdempotencyKey` for the online checkout.
   *
   * WHY CHECKOUT NEEDS IT TOO. A browser or mobile client that times out and
   * retries `POST /orders` previously placed a SECOND order, each holding its
   * own allocation against the same stock, and the customer then had two
   * payable orders for one basket. Retry safety cannot be optional on a path
   * whose failure mode is charging twice.
   */
  private requireCheckoutIdempotencyKey(raw: string | undefined): string {
    const key = (raw ?? '').trim();
    if (key.length === 0) {
      throw new BadRequestException({
        error: 'IDEMPOTENCY_KEY_REQUIRED',
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: CheckoutMessages.IDEMPOTENCY_KEY_REQUIRED,
      });
    }
    if (
      key.length < IDEMPOTENCY_KEY_MIN_LENGTH ||
      key.length > IDEMPOTENCY_KEY_MAX_LENGTH ||
      !CHECKOUT_KEY_CHARSET.test(key)
    ) {
      throw new BadRequestException({
        error: 'IDEMPOTENCY_KEY_INVALID',
        code: 'IDEMPOTENCY_KEY_INVALID',
        message: CheckoutMessages.IDEMPOTENCY_KEY_MALFORMED,
      });
    }
    return key;
  }

  // =====================================================================
  // POS sale (docs/ARCHITECTURE.md R6)
  // =====================================================================

  /**
   * Records an in-store sale.
   *
   * EVERYTHING below commits in ONE transaction or none of it does: the
   * idempotency claim, the customer upsert, the order header, the immutable
   * line snapshots, the stock decrement + displacement + movements (delegated
   * to InventoryService), the payment ledger row and the completed idempotency
   * response.
   *
   * ATTRIBUTION. `actor` comes from the verified access token. `dto.cashierId`
   * and `dto.branchId` are accepted by the DTO purely so old clients do not get
   * a 400, and are then ignored. There is no code path by which a request body
   * can change who a sale is attributed to.
   */
  async createPosOrder(
    dto: CreatePosOrderDto,
    actor: OrderActor,
    // REQUIRED, not optional. It used to be `idempotencyKey?: string` with every
    // claim behind `if (idempotencyKey)`, which made retry protection opt-in --
    // absent in exactly the situations it exists for (a double-tapped "Charge",
    // a terminal retrying a request the server had already committed), both of
    // which rang the sale up twice and decremented stock twice. The controller
    // validates and normalises it; a caller with no key has no business
    // recording a sale, and the type now says so.
    idempotencyKey: string,
  ): Promise<PosSaleResponse> {
    if (actor.branchId === null || actor.branchId === undefined) {
      throw new BadRequestException(OrderMessages.USER_NOT_IN_BRANCH);
    }
    const branchId = actor.branchId;

    // Duplicate variant rows are summed here, BEFORE any availability check,
    // so a basket of [{v:1,q:1},{v:1,q:1}] is one request for 2 units and can
    // never pass two independent "stock >= 1" checks against the same unit.
    const items = this.aggregatePosItems(dto);

    const requestHash = requestHashOf({
      scope: 'pos_sale',
      cashierUserId: actor.userId,
      branchId,
      paymentMethod: dto.paymentMethod,
      mobile: dto.mobile ?? null,
      name: dto.name ?? null,
      items,
    });

    // Fast path: an already-completed identical request never opens a write
    // transaction at all.
    const replay = await peekIdempotencyKey(
      this.dataSource.manager,
      IdempotencyScope.POS_SALE,
      idempotencyKey,
      requestHash,
    );
    if (replay) return replay.responseBody as PosSaleResponse;

    let replayed: PosSaleResponse | null = null;
    let result: {
      response: PosSaleResponse;
      consumed: ConsumedVariantResult[];
    } | null = null;

    try {
      result = await this.dataSource.transaction(async (manager) => {
        // Claimed FIRST, before any row lock, so a duplicate request blocks on
        // the unique index rather than on inventory rows.
        const claim = await claimIdempotencyKey(
          manager,
          IdempotencyScope.POS_SALE,
          idempotencyKey,
          requestHash,
        );

        const response = await this.recordPosSale(manager, dto, {
          userId: actor.userId,
          branchId,
        });

        await completeIdempotencyKey(manager, claim, 201, response.response);
        return response;
      });
    } catch (err) {
      if (err instanceof IdempotentReplayError) {
        replayed = err.responseBody as PosSaleResponse;
      } else {
        throw this.translateInventoryError(err);
      }
    }

    if (replayed) return replayed;

    // R7: notifications are post-commit and advisory. `balanceAfter` is the
    // COMMITTED stock returned by `UPDATE ... RETURNING`, never a value
    // recomputed from the pre-lock snapshot the way the old code did it.
    await this.publishPosSaleEvents(result!.response, result!.consumed);
    return result!.response;
  }

  private async recordPosSale(
    manager: EntityManager,
    dto: CreatePosOrderDto,
    actor: { userId: number; branchId: number },
  ): Promise<{ response: PosSaleResponse; consumed: ConsumedVariantResult[] }> {
    const now = new Date();
    const items = this.aggregatePosItems(dto);

    const cashier = await this.loadActiveActor(manager, actor.userId);
    const cashierDisplay = this.displayNameOf(cashier);

    const branch = await manager
      .getRepository(Branch)
      .findOne({ where: { id: actor.branchId } });
    if (!branch) throw new BadRequestException(OrderMessages.BRANCH_NOT_FOUND);

    /*
     * A RETIRED BRANCH CANNOT SELL (migration 0021).
     *
     * Checked INSIDE the sale transaction, not at login and not in the till's
     * UI. Login is the wrong place because a branch can be retired while a
     * cashier is mid-shift with a live session, and the till is the wrong
     * place because hiding a button is not a control — the sale is what has to
     * be refused, and this is the one path every POS sale goes through.
     *
     * A 409 rather than a 400: the request is well formed and would have
     * succeeded yesterday. Nothing has been written at this point (the
     * idempotency claim is rolled back with the transaction), so a cashier who
     * is moved to an active branch can retry the same sale with the same key.
     */
    if (branch.isActive === false) {
      throw new ConflictException({
        error: BranchErrorCodes.BRANCH_INACTIVE,
        message: BranchMessages.BRANCH_INACTIVE,
        branchId: branch.id,
        branchName: branch.name,
      });
    }

    // Walk-in sale: no mobile, no customer, still a fully attributed sale.
    const customer = dto.mobile
      ? await this.customerService.findOrCreateByMobile(manager, {
          mobile: dto.mobile,
          name: dto.name ?? null,
        })
      : null;

    // R1: ascending variantId lock order, established before anything else
    // touches inventory.
    const locked = await this.inventory.lockVariants(
      manager,
      items.map((i) => i.variantId),
    );

    /*
     * A DEACTIVATED VARIANT CANNOT BE SOLD.
     *
     * Raw physical availability remains visible for inventory management, but
     * `isActive = false` makes the variant unsellable through both Storefront
     * and POS. This is the authoritative enforcement point for the till.
     *
     * WHY HERE, AT THIS EXACT LINE:
     *
     *  - AFTER `lockVariants`, so the value tested is the row-locked one. An
     *    administrator retiring the SKU needs this same row lock to write
     *    `isActive = false`, so either this sale holds the lock first and is
     *    valid when it commits, or the deactivation committed first and the
     *    locked row already reads false. Neither side can observe a stale
     *    active state, and no extra lock or lock ORDER is introduced -- R1 is
     *    untouched, this reads the map R1 already produced.
     *
     *  - BEFORE the order row, the line snapshots, the payment row, the stock
     *    decrement, the reservation displacement and the post-commit events.
     *    Nothing above this point has written anything, so the refusal is
     *    atomic for free: no receipt, no movement rows, no other customer's
     *    basket touched, and (because the whole transaction rolls back) no
     *    surviving idempotency claim, so the cashier may retry the same key
     *    once the SKU is reactivated.
     *
     *  - On the SERVER, never on the client's word. `CreatePosOrderDto`
     *    carries variant ids and quantities only; a stale till that still
     *    believes the SKU is active, a cached catalogue page, a replayed
     *    request and a hand-rolled `curl` all arrive here and all are refused.
     *
     * The till's own blocking of an inactive line stays -- it is what makes
     * the refusal legible to a cashier -- but it is a courtesy, not the
     * control. `items` is the AGGREGATED list, so a duplicate scan of a
     * retired SKU and a direct variant-id submission are the same one row by
     * the time they get here.
     */
    this.inventory.assertSellableUnderLock(
      locked,
      items.map((i) => i.variantId),
    );

    /*
     * THE BRANCH CHANNEL GATE — same transaction, same locks.
     *
     * Deliberately HERE: after the variant rows are locked (so the answer
     * cannot change under us) and BEFORE the order header, the lines, the
     * stock decrement, the payment row and any realtime frame. A refusal from
     * this point leaves NOTHING behind — no order, no items, no payment, no
     * movement, no displaced reservation, no event — which is what makes the
     * sale atomic rather than merely mostly atomic.
     *
     * It reads committed state under a share lock on the product rows, so a
     * visibility change racing this sale resolves to one definite order rather
     * than a stale read. See `ProductVisibilityService.assertSellableInBranch`.
     */
    await this.productVisibility.assertSellableInBranch(
      manager,
      items.map((i) => i.variantId),
      actor.branchId,
    );

    const catalog = await manager.getRepository(ProductVariant).find({
      where: { id: In(items.map((i) => i.variantId)) },
      relations: { product: true, attributeValues: { attribute: true } },
    });
    const catalogById = new Map(catalog.map((v) => [v.id, v]));

    let subtotal = 0;
    const lineDrafts = items.map((item) => {
      const lockRow = locked.get(item.variantId);
      const variant = catalogById.get(item.variantId);
      if (!lockRow || !variant) {
        throw new NotFoundException(
          `Product variant ${item.variantId} not found`,
        );
      }
      // PRICE COMES FROM THE SKU, FULL STOP.
      //
      // This used to fall back to `variant.product?.basePrice`. Under the
      // uniform sellable-SKU model every sellable variant has a price of its
      // own (0 if one was never set), so that fallback could only ever fire for
      // a variant whose price is NULL -- and it would then charge a
      // PRODUCT-level price for a SPECIFIC variant, which is the same class of
      // mistake as the stock bypass: a product-level number standing in for a
      // per-SKU fact. Online checkout has always read the locked variant row
      // only; the two paths now agree.
      const unitPrice = Number(lockRow.price ?? 0);
      // Guarded: `unitPrice` comes from the LOCKED DB row, which may predate
      // the MAX_RIAL bound on the write path, and `item.quantity` is the
      // AGGREGATE of duplicate scans. Neither is re-validated by the DTO.
      const lineTotal = lineTotalRial(unitPrice, item.quantity);
      subtotal += lineTotal;
      return {
        variant,
        quantity: item.quantity,
        unitPrice,
        lineTotal,
        sku: lockRow.sku ?? variant.sku ?? null,
      };
    });

    // Re-fold the line totals in BigInt. `subtotal += lineTotal` above is a
    // double accumulation over up to MAX_ORDER_LINES terms; each term is known
    // exact, their running sum is not, and this is the figure the receipt
    // prints and the till reconciles against.
    subtotal = sumLineTotalsRial(lineDrafts.map((d) => d.lineTotal));

    const orderRepo = manager.getRepository(Order);
    const order = orderRepo.create({
      channel: OrderChannel.POS,
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
      paymentMethod: dto.paymentMethod,
      branchId: actor.branchId,
      branchNameSnapshot: branch.name,
      cashierUserId: cashier.id,
      cashierDisplaySnapshot: cashierDisplay,
      customerId: customer?.id ?? null,
      subtotal,
      total_price: subtotal,
      soldAt: now,
      paid_at: now,
    });
    await orderRepo.save(order);

    const orderNumber = this.buildOrderNumber(OrderChannel.POS, order.id, now);
    await orderRepo.update(order.id, { orderNumber });
    order.orderNumber = orderNumber;

    const orderItemRepo = manager.getRepository(OrderItems);
    const lines = await orderItemRepo.save(
      lineDrafts.map((draft) =>
        orderItemRepo.create({
          orderId: order.id,
          productId: draft.variant.product?.id ?? null,
          variantId: draft.variant.id,
          // Immutable history: renaming, re-pricing or deleting the catalog row
          // later cannot rewrite what this receipt said.
          productTitleSnapshot:
            draft.variant.product?.title ?? 'Unknown product',
          variantSkuSnapshot: draft.sku,
          // Frozen here for the same reason as the title and SKU beside them,
          // plus one the SKU does not have: a code may be RETYPED later.
          productCodeSnapshot: draft.variant.product?.productCode ?? null,
          variantCodeSnapshot: draft.variant.variantCode ?? null,
          attributesSnapshot: this.attributesOf(draft.variant),
          quantity: draft.quantity,
          unit_price: draft.unitPrice,
          total_price: draft.lineTotal,
        }),
      ),
    );

    // ALL stock work is delegated. This service never touches
    // product_variants.stock.
    const consumeResult = await this.inventory.consumeForPosSale(manager, {
      items,
      orderId: order.id,
      actorUserId: cashier.id,
      actorDisplaySnapshot: cashierDisplay,
      branchId: actor.branchId,
      now,
    });

    // One payment ledger for both channels: an in-store sale is a recorded,
    // queryable payment, not an implicit one.
    await manager.getRepository(Payment).save(
      manager.getRepository(Payment).create({
        order,
        amount: subtotal,
        status: PaymentStatusEnum.SUCCESS,
        paid_at: now,
        track_id: null,
      }),
    );

    const response: PosSaleResponse = {
      id: order.id,
      orderNumber,
      channel: OrderChannel.POS,
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
      paymentMethod: dto.paymentMethod,
      soldAt: now.toISOString(),
      voidedAt: null,
      branchId: actor.branchId,
      branchNameSnapshot: branch.name,
      cashierUserId: cashier.id,
      cashierDisplaySnapshot: cashierDisplay,
      customerId: customer?.id ?? null,
      subtotal,
      totalPrice: subtotal,
      items: lines.map((line) => ({
        id: line.id,
        variantId: line.variantId,
        productId: line.productId,
        productTitleSnapshot: line.productTitleSnapshot,
        variantSkuSnapshot: line.variantSkuSnapshot,
        attributesSnapshot: line.attributesSnapshot,
        quantity: line.quantity,
        unitPrice: Number(line.unit_price),
        totalPrice: Number(line.total_price),
      })),
      stock: consumeResult.consumed.map((c) => ({
        variantId: c.variantId,
        quantityConsumed: c.quantityConsumed,
        balanceAfter: c.balanceAfter,
        fromFreeStock: c.fromFreeStock,
        fromDisplacedBaskets: c.fromDisplacedBaskets,
      })),
      displacedBasketLines: consumeResult.affectedBasketLines.length,
    };

    return { response, consumed: consumeResult.consumed };
  }

  // =====================================================================
  // Void / return  (C3)
  // =====================================================================

  /**
   * Reverses a sale that should never have happened. Stock goes back, the sale
   * is stamped `voidedAt`, and an `order_actions` row records WHO voided it.
   * `cashierUserId` is deliberately not in the update set: the original seller
   * is never overwritten.
   */
  voidOrder(id: number, actor: OrderActor, dto: ReverseOrderDto) {
    return this.reverseOrder(id, actor, 'void', dto.reason ?? null);
  }

  /** Customer brought the goods back. Stock goes back, status becomes REFUNDED. */
  returnOrder(id: number, actor: OrderActor, dto: ReverseOrderDto) {
    return this.reverseOrder(id, actor, 'return', dto.reason ?? null);
  }

  private async reverseOrder(
    id: number,
    actor: OrderActor,
    kind: 'void' | 'return',
    reason: string | null,
  ) {
    let restored: ConsumedVariantResult[] = [];

    const order = await this.dataSource
      .transaction(async (manager) => {
        const orderRepo = manager.getRepository(Order);
        const existing = await orderRepo.findOne({
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!existing)
          throw new NotFoundException(OrderMessages.ORDER_NOT_FOUND);

        if (existing.voidedAt) {
          throw new ConflictException(OrderMessages.ORDER_ALREADY_VOIDED);
        }
        if (existing.status === OrderStatusEnum.REFUNDED) {
          throw new ConflictException(
            kind === 'void'
              ? OrderMessages.CANNOT_VOID_REFUNDED
              : OrderMessages.ORDER_ALREADY_RETURNED,
          );
        }
        if (
          kind === 'return' &&
          !(
            [
              OrderStatusEnum.PAID,
              OrderStatusEnum.PROCESSING,
              OrderStatusEnum.SHIPPED,
              OrderStatusEnum.DELIVERED,
            ] as OrderStatusEnum[]
          ).includes(existing.status)
        ) {
          throw new ConflictException(OrderMessages.CANNOT_RETURN_IN_STATUS);
        }

        const acting = await this.loadActor(manager, actor.userId);
        const actingDisplay = this.displayNameOf(acting);
        const now = new Date();

        // A partially refunded order is finished with the line endpoint, never
        // reversed wholesale (docs/PURCHASE-COST-ACCOUNTING.md §5.1).
        await this.inventory.assertNoLineAdjustments(manager, existing.id);

        const restoreResult = await this.inventory.restoreForOrder(manager, {
          orderId: existing.id,
          reason:
            kind === 'void'
              ? StockMovementReason.CANCELLATION_RESTORE
              : StockMovementReason.RETURN_RESTORE,
          actorUserId: acting.id,
          actorDisplaySnapshot: actingDisplay,
          // The SAME rule the sales summary applies: a void reverses revenue
          // only if the money was taken; a return is only allowed from a sale
          // state, so it always does.
          reverseRevenue: kind === 'void' ? existing.paidAt !== null : true,
          now,
        });
        restored = restoreResult.restored;

        const fromStatus = existing.status;
        const toStatus =
          kind === 'void' ? OrderStatusEnum.CANCELED : OrderStatusEnum.REFUNDED;

        await orderRepo.update(existing.id, {
          status: toStatus,
          fulfillmentState: FulfillmentStateEnum.NOT_REQUIRED,
          // Only a VOID stamps voidedAt. A return is counted through
          // `refundedTotal`; stamping both would subtract the same sale twice
          // in `netSales = gross - refunded - voided`.
          //
          // Each reversal records ITS OWN event instant, because reporting dates
          // a reversal by when it happened and not by when the sale happened: an
          // October return of a September sale reduces October. Migration 0009
          // installed a trigger that back-fills these if an application path
          // forgets; writing them here explicitly is what makes the trigger a
          // safety net rather than the mechanism, and it is the reason a reader
          // of this method can see where the reporting date comes from.
          ...(kind === 'void' ? { voidedAt: now } : { refundedAt: now }),
        });

        // Money ledger: the successful payment for this order is marked
        // refunded so `uq_payment_one_success_per_order` reflects reality.
        await manager
          .getRepository(Payment)
          .createQueryBuilder()
          .update(Payment)
          .set({ status: PaymentStatusEnum.REFUNDED })
          .where('"orderId" = :orderId', { orderId: existing.id })
          .andWhere('status = :status', { status: PaymentStatusEnum.SUCCESS })
          .execute();

        await manager.getRepository(OrderAction).insert({
          orderId: existing.id,
          action:
            kind === 'void' ? OrderActionType.VOID : OrderActionType.RETURN,
          fromStatus,
          toStatus,
          actorUserId: acting.id,
          actorDisplaySnapshot: actingDisplay,
          reason,
        });

        return await orderRepo.findOne({
          where: { id: existing.id },
          relations: { items: true, customer: true },
        });
      })
      .catch((err) => {
        throw this.translateInventoryError(err);
      });

    for (const row of restored) {
      // See publishPosSaleEvents: `branchId` is what reaches the shop floor.
      this.realtimeGateway.emitStockEvent({
        variantId: row.variantId,
        newStock: row.balanceAfter,
        branchId: order?.branchId ?? null,
      });
    }
    /*
     * A void/return puts units BACK, so this is what tells the storefront a
     * sold-out variant may be buyable again.
     *
     * It no longer asserts that it IS buyable. This path used to emit
     * `inStock: balanceAfter > 0` with no `isActive` term, so restoring units
     * to a RETIRED variant announced it as available — one of the five
     * incompatible `inStock` derivations the invalidation contract removed.
     * The client now asks, and `deriveAvailability` answers once.
     */
    await this.realtimeGateway.publishAvailabilityInvalidation(
      restored.map((row) => row.variantId),
      'stock',
    );
    this.realtimeGateway.emitOrderEvent('order.status.updated', {
      orderId: id,
      status: order?.status,
      voidedAt: order?.voidedAt ?? null,
      branchId: order?.branchId ?? null,
    });

    return order;
  }

  // =====================================================================
  // Reads / status
  // =====================================================================

  // =====================================================================
  // Owner-scoped customer reads
  //
  // WHY THESE EXIST. `findOne` below is an UNSCOPED staff read, reached only
  // from management routes. Before this, a customer had no way at all to see
  // the orders they had placed -- and the only order-shaped thing they could
  // reach was the checkout endpoint itself. The two methods below take the
  // owner as a MANDATORY parameter so a customer-facing route cannot be
  // written without one.
  //
  // The unbounded staff list that used to sit here (`findAll(branchId?)`,
  // every order ever placed with four relations hydrated) is GONE: the
  // management list is `AdminOrdersService.list`, which is paginated,
  // filtered and projected. See the handler comment on
  // `GET /orders` in `orders.controller.ts`.
  // =====================================================================

  /**
   * This customer's orders, newest first. Never returns anyone else's.
   *
   * PROJECTED, NOT RAW. The rows go through `toCustomerOrderView`, which is an
   * allow-list — see the header of `dto/customer-order.view.ts` for the field
   * list and for what is deliberately withheld. Returning the entities meant
   * every column `orders` grew became part of the customer contract the moment
   * its migration ran, `fulfillmentLastError` (raw internal failure text)
   * included.
   */
  async findAllForUser(
    userId: number,
    page = 1,
    limit = 20,
  ): Promise<CustomerOrderListView> {
    const [data, total] = await this.orderRepository.findAndCount({
      where: { userId },
      /**
       * `items` only, and NOT `items.product`. Every line fact the customer is
       * shown comes from the immutable `order_items.*Snapshot` columns, so the
       * live catalogue row is not merely unnecessary here — loading it is how a
       * later rename or re-price would start rewriting a historical order.
       */
      relations: { items: true },
      order: { id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return toCustomerOrderListView({
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 0,
    });
  }

  /**
   * One of this customer's own orders.
   *
   * Someone else's order is answered NOT FOUND, with the same status and body
   * as an order that does not exist. A 403 would confirm the id is real and let
   * a customer enumerate order ids -- and order numbers are sequential.
   *
   * The ownership comparison runs on the ENTITY, before the projection, so the
   * check cannot be lost by a change to the view.
   */
  async findOneForUser(id: number, userId: number): Promise<CustomerOrderView> {
    const order = await this.orderRepository.findOne({
      where: { id },
      /**
       * The live `address` relation is deliberately NOT loaded: the delivery
       * address the customer is owed is the frozen `addressSnapshot` column,
       * and the live row is a mutable, deletable thing whose current contents
       * are not a fact about this order.
       */
      relations: { items: true },
    });
    if (!order || order.userId !== userId) {
      throw new NotFoundException(OrderMessages.ORDER_NOT_FOUND);
    }
    return toCustomerOrderView(order);
  }

  async findOne(id: number) {
    const order = await this.orderRepository.findOne({
      where: { id },
      relations: {
        user: true,
        address: true,
        cashierUser: true,
        customer: true,
        items: {
          product: true,
        },
      },
    });
    if (!order) throw new NotFoundException(OrderMessages.ORDER_NOT_FOUND);
    return order;
  }

  // The unpaginated audit-trail read that used to sit here
  // (`findActions(orderId)`) is GONE: `GET /orders/:id/actions` is served by
  // `AdminOrdersService.findActions`, which pages the trail and projects it.

  /**
   * Status changes now go through the state machine in
   * `order-status.machine.ts`. Previously ANY enum value was accepted from ANY
   * state, so a DELIVERED order could be pushed back to PENDING.
   *
   * Transitions to CANCELED / REFUNDED are refused here on purpose: they have
   * stock consequences, and `POST /orders/:id/void` and `POST /orders/:id/return`
   * are the operations that restore stock and write the audit row.
   *
   * =========================================================================
   * PAID MAY NOT BECOME PROCESSING/SHIPPED/DELIVERED WITH THE GOODS UNMOVED
   * =========================================================================
   *
   * THE DEFECT THIS CLOSES. This method used to consult exactly three things:
   * `voidedAt`, the canceled/refunded refusal, and the status state machine.
   * It never read `fulfillmentState`. `paid -> processing` was therefore a
   * legal, one-click, unaudited-as-such operation on an order whose stock had
   * never been consumed — and it is a ONE-WAY DOOR:
   *
   *   FulfilmentService.claim()            WHERE status='paid' AND
   *   FulfilmentRecoveryService lease        "fulfillmentState" IN
   *                                          ('pending','awaiting_stock')
   *
   * Both filter on `status = 'paid'`. The moment the order is `processing` it
   * matches neither, and there is no other writer of `fulfillmentState` and no
   * sweep that looks at post-payment statuses. The order is evicted from phase
   * 2 permanently: money taken, goods never allocated, nothing left in any
   * queue to say so. `idx_orders_fulfillment_due` is partial on the same
   * predicate, so the row also drops out of the index an operator would query.
   *
   * THE GUARD runs INSIDE the transaction, AFTER the `pessimistic_write` lock
   * on the order row taken a few lines above. That ordering is the whole
   * concurrency argument: `FulfilmentService.claim()` takes `FOR UPDATE SKIP
   * LOCKED` on the same row before it consumes stock and before it flips
   * `fulfillmentState`, so the two can never interleave. Either
   *
   *   - we hold the lock first: recovery's SKIP LOCKED finds nothing and moves
   *     on, we read the pre-recovery `fulfillmentState`, and we refuse; the
   *     order is untouched and the next recovery pass still sees it; or
   *   - recovery holds the lock first: our `findOne(..., pessimistic_write)`
   *     BLOCKS until recovery commits, and we then read the state recovery
   *     just wrote — FULFILLED — and allow the transition.
   *
   * There is no ordering in which we read a stale FULFILLED, and none in which
   * we evict an order recovery still needs.
   *
   * WHAT THE REFUSAL DOES NOT DO. It writes nothing at all: no status change,
   * no `fulfillmentState` change, no stock row, no stock movement, no
   * `order_actions` row (nothing happened to audit), and no payment row is
   * touched. The order stays exactly as recovery and the reconciliation queue
   * expect to find it.
   */
  async updateStatus(
    id: number,
    updateStatusOrderDto: UpdateStatusOrderDto,
    actor: OrderActor,
  ) {
    const updated = await this.dataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(Order);
      const order = await orderRepo.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) throw new NotFoundException(OrderMessages.ORDER_NOT_FOUND);

      const next = updateStatusOrderDto.status;

      if (order.voidedAt) {
        throw new ConflictException(OrderMessages.ORDER_FROZEN_BY_VOID);
      }
      if (
        next === OrderStatusEnum.CANCELED ||
        next === OrderStatusEnum.REFUNDED
      ) {
        throw new BadRequestException(
          `${OrderMessages.INVALID_STATUS_TRANSITION}: use POST /orders/${id}/void or POST /orders/${id}/return so stock is restored and the action is audited`,
        );
      }
      if (order.status === next) return order;

      if (!canTransitionOrderStatus(order.status, next)) {
        throw new BadRequestException(
          `${OrderMessages.INVALID_STATUS_TRANSITION}: ${order.status} -> ${next}. Allowed from ${order.status}: ${
            allowedNextOrderStatuses(order.status).join(', ') ||
            'none (terminal)'
          }`,
        );
      }

      // The order row is locked (pessimistic_write, above), so this is the
      // committed fulfilment state and it cannot move underneath us.
      if (
        order.status === OrderStatusEnum.PAID &&
        isPostPaymentOperationalStatus(next) &&
        !canAdvancePastPaid(order.fulfillmentState)
      ) {
        throw new ConflictException({
          // Top level `error` — that is where GlobalExceptionFilter promotes a
          // string `error` to, and where clients are told to branch.
          error: OrderErrorCode.ORDER_FULFILMENT_INCOMPLETE,
          message: OrderMessages.ORDER_FULFILMENT_INCOMPLETE,
          // Everything below nests under `details`. Operator-safe facts only:
          // no internal error string (`fulfillmentLastError` is deliberately
          // NOT here), no payment figures, no gateway references.
          orderId: order.id,
          status: order.status,
          fulfillmentState: order.fulfillmentState,
          requestedStatus: next,
          reconciliationQueue: RECONCILIATION_QUEUE_PATH,
        });
      }

      const acting = await this.loadActor(manager, actor.userId);
      const fromStatus = order.status;

      await orderRepo.update(order.id, { status: next });

      await manager.getRepository(OrderAction).insert({
        orderId: order.id,
        action: OrderActionType.STATUS_CHANGE,
        fromStatus,
        toStatus: next,
        actorUserId: acting.id,
        actorDisplaySnapshot: this.displayNameOf(acting),
        reason: null,
      });

      return await orderRepo.findOne({ where: { id: order.id } });
    });

    // Scoped: admins + the owning branch only. This was a global
    // `server.emit(...)`, which pushed order data to EVERY connected socket,
    // including retail storefront customers.
    this.realtimeGateway.emitOrderEvent('order.status.updated', {
      orderId: updated?.id,
      status: updated?.status,
      branchId: updated?.branchId ?? null,
    });

    return updated;
  }

  // =====================================================================
  // Helpers
  // =====================================================================

  /**
   * DUPLICATE LINE POLICY: **aggregate**, do not reject.
   *
   * A POS keypad/scanner naturally emits one line per scan, so `[{v:7,q:1},
   * {v:7,q:1}]` is a normal way to express "two of item 7" and rejecting it
   * would be user-hostile. What must never happen is the old behaviour, where
   * each row was stock-checked independently against the same pre-decrement
   * stock and both passed. Summing first makes the check exact, and the stored
   * order has exactly one line per variant.
   */
  private aggregatePosItems(dto: CreatePosOrderDto): PosConsumeItem[] {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException(OrderMessages.ITEMS_REQUIRED);
    }
    return this.aggregateItems(
      dto.items.map((i) => ({
        variantId: i.productVariantId,
        quantity: i.quantity,
      })),
    );
  }

  private aggregateItems(rows: PosConsumeItem[]): PosConsumeItem[] {
    const totals = new Map<number, number>();
    for (const row of rows) {
      if (!Number.isInteger(row.quantity) || row.quantity < 1) {
        throw new BadRequestException(
          `quantity for variant ${row.variantId} must be a positive integer`,
        );
      }
      totals.set(
        row.variantId,
        (totals.get(row.variantId) ?? 0) + row.quantity,
      );
    }
    if (totals.size === 0) {
      throw new BadRequestException(OrderMessages.ITEMS_REQUIRED);
    }
    // Ascending variantId: R1's deadlock-avoidance lock order.
    return [...totals.entries()]
      .map(([variantId, quantity]) => ({ variantId, quantity }))
      .sort((a, b) => a.variantId - b.variantId);
  }

  private async loadActor(
    manager: EntityManager,
    userId: number,
  ): Promise<User> {
    const user = await manager.getRepository(User).findOne({
      where: { id: userId },
    });
    if (!user) throw new NotFoundException(UserMessages.USER_NOT_FOUND);
    return user;
  }

  private async loadActiveActor(
    manager: EntityManager,
    userId: number,
  ): Promise<User> {
    const user = await this.loadActor(manager, userId);
    if (user.deactivatedAt) {
      throw new ConflictException(OrderMessages.CASHIER_DEACTIVATED);
    }
    return user;
  }

  private displayNameOf(user: User): string {
    return user.username ?? user.mobile ?? `user#${user.id}`;
  }

  private attributesOf(
    variant?: ProductVariant | null,
  ): Record<string, string> | null {
    if (!variant?.attributeValues?.length) return null;
    const out: Record<string, string> = {};
    for (const value of variant.attributeValues) {
      const key = value.attribute?.name;
      if (key) out[key] = value.value;
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  /**
   * Delegates to the shared generator in `order-number.ts`.
   *
   * The format and its length bound live beside the constant the entity and
   * migration 0026 both use, so a change to one cannot leave the other behind.
   */
  private buildOrderNumber(
    channel: OrderChannel,
    id: number,
    at: Date,
  ): string {
    return buildOrderNumber(channel, id, at, this.timezone);
  }

  private async publishPosSaleEvents(
    response: PosSaleResponse,
    consumed: ConsumedVariantResult[],
  ): Promise<void> {
    for (const row of consumed) {
      // `branchId` is REQUIRED here, not decorative. `emitStockEvent` is now
      // staff-scoped (`admins` + `branch:<id>`); a `sale` cashier joins only
      // `branch:<id>` from `users.branchId`, so omitting it delivers the till's
      // own sale to head office and NOT to the shop floor that made it.
      this.realtimeGateway.emitStockEvent({
        variantId: row.variantId,
        newStock: row.balanceAfter,
        branchId: response.branchId,
      });
    }
    /*
     * The customer-safe counterpart. A till sale is the most common way a
     * storefront variant sells out — and the most common way a basket
     * reservation is displaced — so this is the frame that reaches the open
     * cart and the anonymous product page alike.
     *
     * One frame per variant, published once for the whole sale rather than
     * per consumed row.
     */
    await this.realtimeGateway.publishAvailabilityInvalidation(
      consumed.map((row) => row.variantId),
      'stock',
    );
    this.realtimeGateway.emitOrderEvent('order.created', {
      orderId: response.id,
      orderNumber: response.orderNumber,
      channel: response.channel,
      status: response.status,
      totalPrice: response.totalPrice,
      branchId: response.branchId,
      cashierUserId: response.cashierUserId,
    });
  }

  /**
   * ==========================================================================
   * THE ONLY PLACE AN INVENTORY DOMAIN ERROR BECOMES AN HTTP STATUS
   * ==========================================================================
   *
   * `InventoryService` speaks in domain errors, not HTTP exceptions, because it
   * is also driven by the reservation sweeper and the fulfilment worker, for
   * which "409" is meaningless. Every route that drives inventory therefore has
   * to translate — and it must translate HERE rather than at each site, because
   * two hand-rolled mappings drift and the client ends up unable to tell
   * "out of stock" apart from "our database broke".
   *
   * Call sites (all three inside the caller's transaction, so a throw still
   * rolls the whole unit of work back):
   *   - POS sale                (`createPosOrder`)
   *   - void / return           (`reverseOrder`)
   *   - ONLINE CHECKOUT         (`create` -> `checkout`)
   *
   * DEFAULT IS PASS-THROUGH. Anything that is not one of the domain classes
   * below is returned UNCHANGED, so a driver error, a bug or an
   * `HttpException` raised deeper down keeps its own identity and a genuine
   * internal fault is never dressed up as a 409 the client will retry forever.
   *
   * `InsufficientStockForFulfilmentError` is deliberately NOT mapped. It is
   * only ever thrown by `consumeForOnlineFulfilment`, which none of the three
   * call sites above reaches; its one caller is `FulfilmentService`, which
   * catches it and records `AWAITING_STOCK` precisely so a CONFIRMED PAYMENT is
   * not rolled back. Turning it into a 409 here would be turning a recoverable
   * post-payment condition into a client-facing conflict.
   */
  private translateInventoryError(err: unknown): unknown {
    if (err instanceof InsufficientStockError) {
      // 409: this is a state conflict against live stock, not a malformed
      // request. Retrying with a smaller quantity is the client's remedy.
      //
      // `error` carries the machine-readable code (GlobalExceptionFilter
      // promotes it to the TOP level of the body) and `code` repeats it inside
      // `details`, matching what the checkout conflicts already do. Before
      // this, the payload carried NEITHER, so a client could only recognise
      // "out of stock" by matching an English sentence.
      return new ConflictException({
        error: InventoryConflictCode.INSUFFICIENT_STOCK,
        code: InventoryConflictCode.INSUFFICIENT_STOCK,
        message: OrderMessages.NOT_ENOUGH_STOCK,
        // SAFE DETAILS ONLY: the caller's own variant, its SKU, what they asked
        // for and what exists. No other customer's basket, no reservation ids,
        // no branch or cashier attribution, no SQL.
        variantId: err.variantId,
        sku: err.sku ?? null,
        requested: err.requested,
        available: err.available,
        retryable: true,
      });
    }

    if (err instanceof ProductNotAvailableInBranchError) {
      /*
       * 409, like every other "the world is not in a state that permits this"
       * refusal on this path. Nothing was written: the gate runs before the
       * first insert and the whole transaction — idempotency claim included —
       * is rolled back, so the SAME key may be retried once the product is
       * made available.
       *
       * SAFE DETAILS ONLY. Everything echoed here is either something the till
       * already sent or something printed on the line it is refusing, so it
       * can mark the right basket row:
       *
       *   - productId / productCode  -- identifies the family
       *   - variantId / variantCode  -- identifies the exact line
       *   - branchId                 -- the cashier's OWN branch
       *
       * What deliberately does NOT travel: which OTHER branches do carry the
       * product, the branch-visibility mode, the selected-branch list, any
       * stock or reservation quantity, any other customer, and any role data.
       * A cashier must not be able to map a neighbouring shop's range by
       * reading refusals.
       */
      return new ConflictException({
        error: InventoryConflictCode.PRODUCT_NOT_AVAILABLE_IN_BRANCH,
        code: InventoryConflictCode.PRODUCT_NOT_AVAILABLE_IN_BRANCH,
        message: InventoryMessages.PRODUCT_NOT_AVAILABLE_IN_BRANCH,
        productId: err.productId,
        productCode: err.productCode,
        variantId: err.variantId,
        variantCode: err.variantCode,
        branchId: err.branchId,
        // Retrying changes nothing: only an administrator publishing the
        // product to this branch does.
        retryable: false,
      });
    }

    if (err instanceof VariantInactiveError) {
      /*
       * 409, matching the retired-branch refusal directly above in
       * `recordPosSale`: the request is well formed and would have succeeded
       * before the SKU was retired, and nothing has been written (the
       * transaction, including the idempotency claim, is rolled back).
       *
       * SAFE DETAILS ONLY. The till already has both of these on the line it
       * is refusing, so echoing them lets it mark the right row:
       *
       *   - `variantId` -- the caller's own line
       *   - `sku`       -- the string the cashier scanned
       *
       * What deliberately does NOT travel: physical stock, reserved or
       * allocated quantities, any other customer's basket, and any branch or
       * cashier attribution. A refusal must not become a stock-inspection
       * endpoint for a caller who is not allowed one.
       */
      return new ConflictException({
        error: InventoryConflictCode.VARIANT_INACTIVE,
        code: InventoryConflictCode.VARIANT_INACTIVE,
        message: InventoryMessages.VARIANT_INACTIVE,
        variantId: err.variantId,
        sku: err.sku ?? null,
        // Retrying changes nothing: only reactivation does.
        retryable: false,
      });
    }

    if (err instanceof ConcurrentModificationError) {
      /**
       * A guarded conditional UPDATE (R2 / R3) affected a row count other than
       * 1 — the operation was rolled back and nothing was applied.
       *
       * 409 and not 500: from the client's side this is a lost race on shared
       * state and re-submitting is the remedy, which is exactly what 409 means.
       *
       * NOTE WHAT IS NOT FORWARDED: `err.message` interpolates the entity id
       * and the affected-row count (`(reservation 812, affected=0)`), which is
       * internal ledger detail, and the id belongs to a shared sequence. Only
       * the entity KIND goes out, with a clean message.
       */
      return new ConflictException({
        error: InventoryConflictCode.INVENTORY_CONCURRENTLY_MODIFIED,
        code: InventoryConflictCode.INVENTORY_CONCURRENTLY_MODIFIED,
        message:
          err.entity === 'reservation'
            ? InventoryMessages.RESERVATION_CONCURRENTLY_MODIFIED
            : err.entity === 'variant'
              ? InventoryMessages.STOCK_CONCURRENTLY_MODIFIED
              : InventoryMessages.CART_LINE_CONCURRENTLY_MODIFIED,
        entity: err.entity,
        retryable: true,
      });
    }

    return err;
  }
}
