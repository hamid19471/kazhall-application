import { Module } from '@nestjs/common';

import { RealtimeModule } from 'src/modules/realtime/realtime.module';

import { PricingController } from './pricing.controller';
import { PricingPlansService } from './pricing-plans.service';
import { PricingRunnerService } from './pricing-runner.service';

/**
 * Monthly cost-recovery pricing plans (`/admin/pricing-plans/*`,
 * docs/MONTHLY-PRICING.md).
 *
 * A module of its own for the same reason `CostingModule` is one: its routes
 * are role-gated and non-delegable, and keeping them on their own controller
 * means that rule cannot be applied to — or dropped from — anyone else's
 * routes by accident. `AuditModule` and `CacheModule` are `@Global()`.
 */
@Module({
  imports: [RealtimeModule],
  controllers: [PricingController],
  providers: [PricingPlansService, PricingRunnerService],
  exports: [PricingRunnerService],
})
export class PricingModule {}
