import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { ReportsModule } from '../reports/reports.module';

/**
 * No `TypeOrmModule.forFeature` and no repositories: every query here is a
 * hand-written aggregate over several tables at once, which the repository API
 * cannot express without either N+1 round trips or an entity graph nobody
 * wants to load. The `DataSource` is injected directly and each query is
 * parameterised.
 */
@Module({
  // For ProfitReportService: the financial route's gross-profit headline.
  imports: [ReportsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
