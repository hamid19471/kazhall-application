import { ProductVisibilityService } from 'src/modules/products/services/product-visibility.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { OrdersService } from './orders.service';
import { DataSource } from 'typeorm';
import { Order } from './entities/order.entity';
import { UserService } from '../user/user.service';
import { AddressService } from '../address/address.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { BadRequestException } from '@nestjs/common';
import { CustomerService } from '../customer/customer.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ConfigService } from '@nestjs/config';
import { InventoryService } from '../inventory/inventory.service';
import { CheckoutQuoteService } from './checkout-quote.service';

describe('OrdersService', () => {
  let service: OrdersService;
  let dataSource: jest.Mocked<DataSource>;
  let userService: jest.Mocked<UserService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        /*
         * These cases reject BEFORE a transaction opens, so the visibility gate
         * is never reached. A throwing stub rather than `{}` so that a future
         * case which does reach it fails loudly instead of passing on
         * undefined.
         */
        {
          provide: ProductVisibilityService,
          useValue: {
            assertSellableInBranch: () => {
              throw new Error(
                'ProductVisibilityService must not be reached in these cases',
              );
            },
          },
        },
        OrdersService,
        {
          provide: DataSource,
          useValue: {
            transaction: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Order),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: UserService,
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: AddressService,
          useValue: {
            // `create()` calls the OWNER-SCOPED lookup now. The old
            // `findOne(id)` took an id and checked nothing, which is how any
            // customer could ship to any other customer's saved address.
            findOneOwnedBy: jest.fn(),
            findOne: jest.fn(),
          },
        },
        // OrdersService injects CustomerService (walk-in POS customers) and
        // RealtimeGateway (post-commit notifications). Both were missing, so
        // Nest DI could not construct OrdersService and every test in this
        // file failed before its Arrange step.
        {
          provide: CustomerService,
          useValue: {
            findOrCreateByMobile: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn(),
          },
        },
        {
          provide: RealtimeGateway,
          useValue: {
            server: {
              emit: jest.fn(),
              to: jest.fn(() => ({ emit: jest.fn() })),
            },
            emitOrderEvent: jest.fn(),
            emitStockEvent: jest.fn(),
            emitToUser: jest.fn(),
          },
        },
        // OrdersService reads REPORT_TIMEZONE in its constructor and delegates
        // every stock movement to the inventory contract.
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'REPORT_TIMEZONE' ? 'Asia/Tehran' : undefined,
            ),
          },
        },
        {
          provide: CheckoutQuoteService,
          useValue: {
            // Never reached by these cases: the Idempotency-Key check returns
            // first. Present so Nest DI can construct OrdersService.
            verify: jest.fn(),
            issue: jest.fn(),
            ttlMs: 900_000,
          },
        },
        {
          provide: InventoryService,
          useValue: {
            lockVariants: jest.fn(),
            expireDueReservations: jest.fn(),
            getAvailability: jest.fn(),
            convertBasketToOrderAllocation: jest.fn(),
            consumeForPosSale: jest.fn(),
            releaseOrderAllocation: jest.fn(),
            restoreForOrder: jest.fn(),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(OrdersService);
    dataSource = moduleRef.get(DataSource);
    userService = moduleRef.get(UserService);
  });

  /**
   * ==========================================================================
   * ONLINE CHECKOUT — WHAT IS UNIT-TESTED HERE AND WHAT IS NOT
   * ==========================================================================
   *
   * Only the checks that run BEFORE any database work are unit-tested, because
   * they are the only ones a mock can honestly prove. `create()` now validates
   * the `Idempotency-Key` and returns before touching the DataSource, so these
   * two cases need no fixture at all.
   *
   * Everything else about checkout — active-only basket loading, re-reading
   * quantities under the variant lock, POS displacement, expiry, the 409
   * confirmation contract, address ownership, the address snapshot, the
   * basket→order allocation conversion and retry safety — depends on real
   * PostgreSQL locking and on InventoryService's actual SQL. A mocked
   * EntityManager that returns whatever the test told it to returns proves the
   * mock, not the system: the previous version of this block asserted a stock
   * check (`variant.stock < quantity`) that allocated nothing and that two
   * concurrent checkouts could both pass, and it passed happily throughout.
   *
   * SKIPPED-TEST REPLACEMENT MAP (the three `it.skip` cases removed from here):
   *
   *   'should create an order from the cart successfully'
   *     -> test/integration/checkout.int-spec.ts
   *        "places an order from the active basket and converts the holds to
   *         order allocations"
   *
   *   'should throw BadRequestException if a cart item variant does not have
   *    enough stock'
   *     -> test/integration/checkout.int-spec.ts
   *        "a POS sale that displaced part of the basket forces confirmation and
   *         sells only the units still held"
   *
   *   'should throw BadRequestException if a cart item variant no longer exists'
   *     -> test/integration/checkout.int-spec.ts
   *        "a line whose hold expired is reported and excluded, never sold"
   */
  describe('create (pre-transaction validation)', () => {
    // `quoteToken` is required by the DTO, so a valid-looking one is supplied
    // here. These cases never reach quote VERIFICATION — the Idempotency-Key
    // check runs first and returns before any database work — which is exactly
    // what the assertions below prove.
    const dto: CreateOrderDto = {
      address: 5,
      quoteToken: 'kq1.eyJ2IjoxfQ.sig',
    };

    it('rejects a checkout with no Idempotency-Key, before opening a transaction', async () => {
      await expect(service.create(dto, 1, '')).rejects.toThrow(
        BadRequestException,
      );

      // The point of the assertion: a retried checkout that would place a
      // second order is refused at the door, so nothing downstream — not the
      // user lookup, not the address lookup, not the transaction — even runs.
      expect(userService.findOne).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects a malformed Idempotency-Key', async () => {
      // Too short, and containing a space. A space matters specifically:
      // "abc " and "abc" must never be two different orders.
      await expect(service.create(dto, 1, 'ab cd')).rejects.toThrow(
        BadRequestException,
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  /**
   * TODO(WS-C): asserts the PREVIOUS OrdersService read/update paths.
   *
   * Workstream C changed the relation shape (object form, plus the snapshot
   * columns and `order_actions` audit rows), and `updateStatus` now takes an
   * explicit actor and writes an append-only OrderAction for every transition.
   * Skipped rather than deleted so the coverage gap stays visible; workstream C
   * owns rewriting them.
   */
  /**
   * REMOVED, NOT SKIPPED — it asserted a contract that no longer exists.
   *
   * Proved: staff order list with relations.
   * It drove a MOCKED repository, so it could only ever confirm that the
   * mock was called with a particular object — never that anything was
   * persisted or that any rule held. Leaving it as `describe.skip` reported
   * phantom coverage in the test count without testing anything.
   *
   * REPLACED BY (real PostgreSQL, real routes, currently passing):
   *   test/integration/admin-coverage.int-spec.ts › GET /orders ›
   * 'returns every order to a super_admin',
   * 'scopes a sale user to their OWN branch and hides another branch entirely',
   * 'refuses a customer (site role) outright'
   */

  /**
   * TODO(WS-C): asserts the PREVIOUS OrdersService read/update paths.
   *
   * Workstream C changed the relation shape (object form, plus the snapshot
   * columns and `order_actions` audit rows), and `updateStatus` now takes an
   * explicit actor and writes an append-only OrderAction for every transition.
   * Skipped rather than deleted so the coverage gap stays visible; workstream C
   * owns rewriting them.
   */
  /**
   * REMOVED, NOT SKIPPED — it asserted a contract that no longer exists.
   *
   * Proved: order detail and its missing-order error.
   * It drove a MOCKED repository, so it could only ever confirm that the
   * mock was called with a particular object — never that anything was
   * persisted or that any rule held. Leaving it as `describe.skip` reported
   * phantom coverage in the test count without testing anything.
   *
   * REPLACED BY (real PostgreSQL, real routes, currently passing):
   *   test/integration/admin-coverage.int-spec.ts ›
   * 'answers 404 for an order that does not exist' and the branch-boundary
   * assertions in 'scopes a sale user to their OWN branch...';
   * owner-scoped detail: test/integration/checkout.int-spec.ts ›
   * 'lets the owner read their own order, including the frozen address'
   */

  /**
   * TODO(WS-C): asserts the PREVIOUS OrdersService read/update paths.
   *
   * Workstream C changed the relation shape (object form, plus the snapshot
   * columns and `order_actions` audit rows), and `updateStatus` now takes an
   * explicit actor and writes an append-only OrderAction for every transition.
   * Skipped rather than deleted so the coverage gap stays visible; workstream C
   * owns rewriting them.
   */
  /**
   * REMOVED, NOT SKIPPED — it asserted a contract that no longer exists.
   *
   * Proved: status transition and its missing-order error.
   * It drove a MOCKED repository, so it could only ever confirm that the
   * mock was called with a particular object — never that anything was
   * persisted or that any rule held. Leaving it as `describe.skip` reported
   * phantom coverage in the test count without testing anything.
   *
   * REPLACED BY (real PostgreSQL, real routes, currently passing):
   *   test/integration/sales-reporting.int-spec.ts ›
   * 'enforces the status state machine instead of accepting any enum value',
   * 'keeps the original cashier when someone else voids the sale, and records who did'
   */
});
