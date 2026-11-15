import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AdminInventoryController } from './admin-inventory.controller';
import { AdminInventoryService } from './admin-inventory.service';
import { StockMovement } from './entities/stock-movement.entity';
import { StockReservation } from './entities/stock-reservation.entity';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { PosCatalogService } from './pos-catalog.service';
import { ReservationSweeperService } from './reservation-sweeper.service';
import { RealtimeModule } from '../realtime/realtime.module';

/**
 * Inventory core.
 *
 * `InventoryService` is a HARD CONTRACT: workstreams B (stock adjust) and C
 * (POS / orders) inject it by that class token, so neither the class name nor
 * this export path may change without the lead agent.
 *
 * Import this module wherever InventoryService is needed; it is stateless and
 * every method composes into the caller's transaction.
 *
 * ---------------------------------------------------------------------------
 * STOCK IS GLOBAL, NOT PER BRANCH.
 *
 * `product_variants.stock` is one number per sellable unit. Nothing in
 * `stock_reservations` or `stock_movements` partitions it by branch —
 * `stock_movements.branchId` records where a sale was rung up, not which shelf
 * it came off — so a POS sale in one branch and an online basket compete for
 * exactly the same units. `STOCK_SCOPE` in `views/admin-inventory.view.ts`
 * states that as an exported constant, and the admin stock list puts it on the
 * wire, so no client has to hard-code the disclosure.
 *
 * This module deliberately does NOT import `ProductsModule`: `ProductsModule`
 * imports this one, and closing that loop would need `forwardRef()` on both
 * sides. See `AdminInventoryController` for how it reaches `ProductsService`
 * without the cycle.
 * ---------------------------------------------------------------------------
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([StockReservation, StockMovement]),
    // The expiry sweeper announces the variants whose holds it released, so an
    // open basket and an open till both learn a SKU is buyable again without
    // waiting for their next poll. Emission is post-commit only; see
    // `ReservationSweeperService.publishExpiries`.
    RealtimeModule,
  ],
  controllers: [InventoryController, AdminInventoryController],
  providers: [
    InventoryService,
    AdminInventoryService,
    PosCatalogService,
    ReservationSweeperService,
  ],
  exports: [InventoryService, ReservationSweeperService],
})
export class InventoryModule {}
