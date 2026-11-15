import { Module } from '@nestjs/common';
import { ProductsModule } from 'src/modules/products/products.module';
import { OrdersService } from './orders.service';
import { AdminOrdersService } from './admin-orders.service';
import { CheckoutQuoteService } from './checkout-quote.service';
import { OrdersController } from './orders.controller';
import { OrderAdjustmentsController } from './order-adjustments.controller';
import { OrderAdjustmentsService } from './order-adjustments.service';
import { CustomerOrdersController } from './customer-orders.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from './entities/order.entity';
import { OrderItems } from './entities/order-item.entity';
import { OrderAction } from './entities/order-action.entity';
import { UserModule } from 'src/modules/user/user.module';
import { AddressModule } from 'src/modules/address/address.module';
import { ProductVariant } from '../products/entities/product-variant.entity';
import { CartItem } from '../cart/entities/cart-item.entity';
import { Payment } from '../payment/entities/payment.entity';
import { Branch } from '../branch/entities/branch.entity';
import { User } from '../user/entities/user.entity';
import { IdempotencyKey } from 'src/common/entities/idempotency-key.entity';
import { CustomerModule } from '../customer/customer.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { InventoryModule } from '../inventory/inventory.module';

/**
 * `InventoryModule` is workstream D's; `InventoryService` is injected by class
 * token as its module doc requires. Orders NEVER touches
 * `product_variants.stock` itself -- every decrement, restore and displacement
 * goes through that service so R1/R2/R3 hold in one place.
 *
 * `ProductsModule` and `HttpModule` used to be imported and were never used;
 * they dragged Redis and MinIO into the orders dependency graph for nothing.
 */
@Module({
  imports: [
    /*
     * For `ProductVisibilityService` only — the POS sale asks the SAME service
     * the Admin write path uses whether a product may be sold in the cashier's
     * branch. Importing the module rather than re-implementing the query is
     * what keeps the two answers from drifting apart.
     */
    ProductsModule,
    TypeOrmModule.forFeature([
      Order,
      OrderItems,
      OrderAction,
      ProductVariant,
      CartItem,
      Payment,
      Branch,
      User,
      IdempotencyKey,
    ]),
    InventoryModule,
    CustomerModule,
    UserModule,
    AddressModule,
    RealtimeModule,
  ],
  controllers: [
    OrdersController,
    CustomerOrdersController,
    // Role-only (super_admin): partial returns/refunds carry cost figures.
    OrderAdjustmentsController,
  ],
  // `AdminOrdersService` is READ-ONLY and is deliberately NOT exported: the
  // admin console's projections have exactly one consumer, and exporting them
  // is how a screen's view shape becomes another module's dependency.
  providers: [
    OrdersService,
    AdminOrdersService,
    CheckoutQuoteService,
    OrderAdjustmentsService,
  ],
  exports: [OrdersService, CheckoutQuoteService],
})
export class OrdersModule {}
