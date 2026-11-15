import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReportsService } from './reports.service';
import { ProfitReportService } from './profit-report.service';
import { ReportsController } from './reports.controller';
import { Order } from '../orders/entities/order.entity';
import { OrderItems } from '../orders/entities/order-item.entity';
import { OrderAction } from '../orders/entities/order-action.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Order, OrderItems, OrderAction])],
  controllers: [ReportsController],
  providers: [ReportsService, ProfitReportService],
  exports: [ReportsService, ProfitReportService],
})
export class ReportsModule {}
