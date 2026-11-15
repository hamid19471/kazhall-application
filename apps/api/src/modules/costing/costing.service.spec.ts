import { ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { CatalogCacheService } from 'src/database/cache.service';
import { AuditService } from 'src/modules/audit/audit.service';
import { InventoryService } from 'src/modules/inventory/inventory.service';
import { RealtimeGateway } from 'src/modules/realtime/realtime.gateway';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

import { CostingPrincipal, CostingService } from './costing.service';

/**
 * DEFENCE IN DEPTH (docs/PURCHASE-COST-ACCOUNTING.md §8): every public method
 * refuses a principal without the built-in super_admin role BEFORE it touches
 * the database — whatever the controller's decorators say. The collaborators
 * are traps: any call on them fails the test.
 */
describe('CostingService role assertion', () => {
  const trap = () =>
    new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === 'then') return undefined;
          throw new Error(`collaborator touched: ${String(prop)}`);
        },
      },
    );

  const service = new CostingService(
    trap() as DataSource,
    trap() as InventoryService,
    trap() as AuditService,
    trap() as CatalogCacheService,
    trap() as RealtimeGateway,
  );

  const principals: Array<[string, CostingPrincipal]> = [
    ['no roles', principal([])],
    ['a cashier', principal([UserRoleEnum.sale])],
    ['a customer', principal([UserRoleEnum.site])],
  ];

  function principal(roles: UserRoleEnum[]): CostingPrincipal {
    return { userId: 1, roles, actor: { userId: 1, display: 'x' } };
  }

  const calls: Array<[string, (p: CostingPrincipal) => Promise<unknown>]> = [
    ['getVariant', (p) => service.getVariant(1, p)],
    ['getProduct', (p) => service.getProduct(1, p)],
    ['listUnvalued', (p) => service.listUnvalued({ page: 1, limit: 10 }, p)],
    [
      'recordReceipt',
      (p) =>
        service.recordReceipt(1, { quantity: 1, unitCost: 1 }, 'key-00001', p),
    ],
    [
      'recordCorrection',
      (p) =>
        service.recordCorrection(
          1,
          { quantityDelta: -1, reason: 'test' },
          'key-00001',
          p,
        ),
    ],
    [
      'initialiseValuation',
      (p) =>
        service.initialiseValuation(
          1,
          { expectedUnvaluedQuantity: 1, unitCost: 1 },
          'key-00001',
          p,
        ),
    ],
    [
      'setPurchasePrice',
      (p) => service.setPurchasePrice(1, { unitCost: 1 }, p),
    ],
  ];

  for (const [method, run] of calls) {
    it.each(principals)(
      `${method} refuses %s with PURCHASE_COST_FORBIDDEN`,
      async (_n, p) => {
        const err = await run(p).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err as ForbiddenException).getResponse()).toMatchObject({
          error: 'PURCHASE_COST_FORBIDDEN',
        });
      },
    );
  }
});
