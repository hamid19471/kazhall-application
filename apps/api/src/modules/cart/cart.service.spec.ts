import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { CartService } from './cart.service';
import { InventoryService } from '../inventory/inventory.service';
import { RealtimeGateway } from 'src/modules/realtime/realtime.gateway';

/**
 * ============================================================================
 * REWRITTEN for the transactional CartService (workstream D).
 *
 * The previous version of this file mocked a `CartService` that took four
 * repositories/services and did read-modify-write on `variant.stock`. That
 * design is gone: every basket write now composes into ONE transaction with
 * `InventoryService`, which is the only thing allowed to touch stock.
 *
 * WHAT IS AND IS NOT TESTED HERE
 * ------------------------------
 * Only input validation lives here -- the parts that are genuinely independent
 * of the database.
 *
 * Everything that actually matters about this service is a property of
 * concurrent PostgreSQL transactions: `FOR UPDATE` lock ordering, partial
 * unique indexes, guarded conditional UPDATEs, 4h tranche expiry, POS
 * displacement. A mocked EntityManager can be made to "prove" any of those and
 * would prove none of them. They are covered for real, against a disposable
 * PostgreSQL, in:
 *
 *   test/integration/reservation-lifecycle.int-spec.ts      (11-14)
 *   test/integration/pos-displacement.int-spec.ts           (15-18)
 *   test/integration/inventory-concurrency.int-spec.ts      (19)
 *   test/integration/basket-recovery-privacy.int-spec.ts    (20-21)
 * ============================================================================
 */
describe('CartService', () => {
  let service: CartService;
  let dataSource: DataSource;
  let inventoryService: InventoryService;

  beforeEach(() => {
    // Deliberately never reached: every case below must reject during argument
    // validation, before a transaction is opened. If one of them ever starts
    // hitting the database, this throws instead of silently passing.
    dataSource = {
      transaction: () => {
        throw new Error('no transaction should be opened for invalid input');
      },
    } as unknown as DataSource;
    inventoryService = {} as InventoryService;
    // The gateway is never reached in these cases: every one of them is
    // rejected before a transaction opens, and the publish is post-commit.
    const realtime = {
      publishAvailabilityInvalidation: () => Promise.resolve(),
    } as unknown as RealtimeGateway;
    service = new CartService(dataSource, inventoryService, realtime);
  });

  describe('create', () => {
    it('rejects a non-positive quantity before touching the database', async () => {
      await expect(
        service.create({ productId: 1, variantId: 2, quantity: 0 }, 7),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.create({ productId: 1, variantId: 2, quantity: -3 }, 7),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('updateQuantity', () => {
    it('rejects a negative quantity before touching the database', async () => {
      await expect(service.updateQuantity(1, -1, 7)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('treats quantity 0 as a removal rather than a zero-unit reservation', async () => {
      const remove = jest.spyOn(service, 'remove').mockResolvedValue(undefined);

      await expect(service.updateQuantity(42, 0, 7)).resolves.toBeNull();
      expect(remove).toHaveBeenCalledWith(42, 7);
    });
  });
});
