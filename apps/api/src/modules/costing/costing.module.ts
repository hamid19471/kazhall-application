import { Module } from '@nestjs/common';

import { InventoryModule } from 'src/modules/inventory/inventory.module';
import { RealtimeModule } from 'src/modules/realtime/realtime.module';

import { CostingController } from './costing.controller';
import { CostingService } from './costing.service';

/**
 * The super_admin costing console (`/admin/costing/*`).
 *
 * A module of its own rather than more handlers on `AdminInventoryController`:
 * that controller is permission-gated and delegable by design, and this one is
 * role-gated and deliberately not. Keeping the two rules on two classes means
 * neither can be applied to the other's routes by accident.
 *
 * `AuditModule` and `CacheModule` are `@Global()`; the valuation pool itself is
 * `InventoryService`'s, reached through `InventoryModule`.
 */
@Module({
  imports: [InventoryModule, RealtimeModule],
  controllers: [CostingController],
  providers: [CostingService],
})
export class CostingModule {}
