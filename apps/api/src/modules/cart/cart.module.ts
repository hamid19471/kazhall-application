import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { InventoryModule } from '../inventory/inventory.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { Product } from '../products/entities/product.entity';
import { ProductVariant } from '../products/entities/product-variant.entity';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { CartItem } from './entities/cart-item.entity';

/**
 * CartModule deliberately does NOT depend on ProductsService or UserService any
 * more: basket writes have to happen inside one transaction together with the
 * stock reservation, and a Redis-cached product read is not transactional.
 * Products are read straight from the caller's EntityManager instead.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([CartItem, Product, ProductVariant]),
    InventoryModule,
    /**
     * Basket writes now announce that storefront availability went stale. See
     * `CartService`'s constructor for why a hold is a `reservation`
     * invalidation and never a `stock` one. `RealtimeModule` depends on
     * nothing in this module, so there is no cycle.
     */
    RealtimeModule,
  ],
  controllers: [CartController],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
