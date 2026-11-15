import { Module } from '@nestjs/common';
import { ProductsService } from './services/products.service';
import { ProductsController } from './controllers/products.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from './entities/product.entity';
import { Category } from 'src/modules/categories/entities/category.entity';
import { AttributeController } from './controllers/attribute.controller';
import { AttributeService } from './services/attribute.service';
import { ProductAttribute } from './entities/product-attribute.entity';
import { ProductAttributeValue } from './entities/product-attribute-value.entity';
import { ProductVariant } from './entities/product-variant.entity';
import { ProductImage } from './entities/product-image.entity';
import { ProductBranchVisibility } from './entities/product-branch-visibility.entity';
import { ProductCodeService } from './services/product-code.service';
import { ProductVisibilityService } from './services/product-visibility.service';
import { ProductImageCleanupService } from './services/product-image-cleanup.service';
import { CacheModule } from 'src/database/cache.module';
import { InventoryModule } from 'src/modules/inventory/inventory.module';
import { RealtimeModule } from 'src/modules/realtime/realtime.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Product,
      Category,
      ProductAttribute,
      ProductAttributeValue,
      ProductVariant,
      ProductImage,
      ProductBranchVisibility,
    ]),
    CacheModule,
    // Stock is owned by inventory. The catalog reads availability and
    // delegates admin stock edits through IInventoryService rather than
    // touching product_variants.stock itself.
    InventoryModule,
    // An admin stock adjustment and a variant retirement are both availability
    // changes, and until now neither produced a frame: a till and a storefront
    // learned about them only on their next poll or page load.
    RealtimeModule,
  ],
  controllers: [ProductsController, AttributeController],
  providers: [
    ProductsService,
    AttributeService,
    ProductCodeService,
    ProductVisibilityService,
    ProductImageCleanupService,
  ],
  /*
   * `ProductVisibilityService` is exported because the POS sale path and the
   * basket both have to ask the SAME question this module answers — "may this
   * product be sold here / on the site" — and a second implementation in
   * another module is exactly how two surfaces end up disagreeing.
   */
  exports: [
    ProductsService,
    AttributeService,
    ProductCodeService,
    ProductVisibilityService,
  ],
})
export class ProductsModule {}
