import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { InventoryModule } from '../inventory/inventory.module';
import { Order } from '../orders/entities/order.entity';
import { RealtimeModule } from '../realtime/realtime.module';
import { FulfilmentRecoveryService } from './fulfilment-recovery.service';
import { FulfilmentService } from './fulfilment.service';
import { PAYMENT_GATEWAY } from './gateways/payment-gateway.interface';
import { StubPaymentGateway } from './gateways/stub.gateway';
import { ZibalPaymentGateway } from './gateways/zibal.gateway';
import { Payment } from './entities/payment.entity';
import { PaymentAction } from './entities/payment-action.entity';
import { PaymentConfig } from './payment.config';
import { ReconciliationService } from './reconciliation.service';
import { PaymentController } from './payment.controller';
import { PaymentReverificationService } from './payment-reverification.service';
import { PaymentService } from './payment.service';
import { ProvisionalPaymentPolicy } from './provisional-policy';

/**
 * PaymentModule no longer imports OrdersModule.
 *
 * Payment only needs a handful of columns from `orders`, and it reads them
 * transactionally from the caller's EntityManager. Dropping the dependency
 * keeps workstream C's OrdersModule (which imports InventoryModule) from
 * forming a cycle with payment.
 *
 * The gateway is bound behind the `PAYMENT_GATEWAY` token so tests get the
 * deterministic stub and never touch a live gateway.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Payment, PaymentAction, Order]),
    RealtimeModule,
    InventoryModule,
  ],
  controllers: [PaymentController],
  providers: [
    PaymentConfig,
    ZibalPaymentGateway,
    StubPaymentGateway,
    {
      provide: PAYMENT_GATEWAY,
      inject: [PaymentConfig, ZibalPaymentGateway, StubPaymentGateway],
      useFactory: (
        config: PaymentConfig,
        zibal: ZibalPaymentGateway,
        stub: StubPaymentGateway,
      ) => (config.driver === 'stub' ? stub : zibal),
    },
    // Every owner-unapproved business decision in this module lives in exactly
    // one provider, and it refuses to activate in production without an
    // explicit acknowledgement. See provisional-policy.ts.
    ProvisionalPaymentPolicy,
    FulfilmentService,
    FulfilmentRecoveryService,
    PaymentService,
    // Depends on PaymentService (not the other way round), so no cycle: the
    // sweep re-drives the ordinary Verify() path instead of duplicating it.
    PaymentReverificationService,
    // Owner decision D-2: the manual reconciliation queue. It reuses
    // FulfilmentService's unchanged boundary for retries and
    // InventoryService's movement-derived restore for refunds, so it adds no
    // second implementation of either.
    ReconciliationService,
  ],
  exports: [
    PaymentService,
    FulfilmentService,
    FulfilmentRecoveryService,
    PaymentReverificationService,
    ReconciliationService,
  ],
})
export class PaymentModule {}
