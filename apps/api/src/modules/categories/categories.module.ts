import { Module } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CategoriesController } from './categories.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Category } from './entities/category.entity';
import { Product } from 'src/modules/products/entities/product.entity';
import { CacheModule } from 'src/database/cache.module';

@Module({
  imports: [TypeOrmModule.forFeature([Category, Product]), CacheModule],
  controllers: [CategoriesController],
  providers: [CategoriesService],
})
export class CategoriesModule {}
