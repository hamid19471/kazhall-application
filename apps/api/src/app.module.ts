import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { join } from 'path';
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BranchModule } from './modules/branch/branch.module';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from './modules/auth/guards/roles.guard';
import { PermissionsGuard } from './modules/auth/guards/permissions.guard';
import { AddressModule } from './modules/address/address.module';
import { ProductsModule } from './modules/products/products.module';
import { OrdersModule } from './modules/orders/orders.module';
import { CartModule } from './modules/cart/cart.module';
import { CustomerModule } from './modules/customer/customer.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { PaymentModule } from './modules/payment/payment.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { ReportsModule } from './modules/reports/reports.module';
import { CostingModule } from './modules/costing/costing.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { HealthModule } from './modules/health/health.module';
import { SeederModule } from './database/seeder/seeder.module';
import { AuditModule } from './modules/audit/audit.module';
import { PermissionsModule } from './modules/auth/permissions/permissions.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { CacheModule } from './database/cache.module';
import { GlobalExceptionFilter } from './common/exceptions/global.exception';
import { validateEnv } from './configs/env.validation';
import { StorageModule } from './common/storage/storage.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: join(process.cwd(), '.env'),
      // Fail fast, naming the offending variable. A missing
      // JWT_ACCESS_EXPIRATION used to boot cleanly and then 500 on EVERY
      // login, because @nestjs/jwt throws on `expiresIn: undefined`.
      validate: validateEnv,
    }),
    //database
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST'),
        port: Number(configService.get<number>('DB_PORT')),
        username: configService.get<string>('DB_USERNAME'),
        password: configService.get<string>('DB_PASSWORD'),
        database: configService.get<string>('DB_DATABASE'),
        entities: [__dirname + '/**/entities/*.entity{.ts,.js}'],
        migrations: [__dirname + '/migrations/*{.ts,.js}'],
        /*
         * NEVER. In any environment.
         *
         * This used to be `NODE_ENV !== 'production' && !== 'test'`, i.e. ON
         * for development — and an unset NODE_ENV defaults to `development`,
         * so a misconfigured process pointed at any database would silently
         * auto-DDL it. Synchronize also masks drift: it is exactly how an
         * unmigrated column (product_variants.isActive) once reached a green
         * test run. The migrations under src/migrations are now the only thing
         * that may change the schema, in every environment without exception.
         */
        synchronize: false,
      }),
    }),
    // Both are @Global(). Registered FIRST so every management module below
    // can write to the administrative trail and expand roles into capabilities
    // without importing them — and, in `UserModule`'s case, without a
    // `forwardRef` cycle back into `AuthModule`.
    /*
     * Global, and deliberately early: it resolves and validates object-
     * storage configuration at boot, so a production deployment missing
     * S3_* fails HERE rather than on the first image upload somebody
     * attempts days later.
     */
    StorageModule,
    AuditModule,
    PermissionsModule,
    AuthModule,
    UserModule,
    BranchModule,
    AddressModule,
    ProductsModule,
    CategoriesModule,
    PaymentModule,
    OrdersModule,
    CartModule,
    CustomerModule,
    RealtimeModule,
    // CacheModule is @Global(), but a global module still has to be imported
    // once. Registering it at the root makes CatalogCacheService available
    // everywhere rather than only where ProductsModule happens to be pulled in.
    CacheModule,
    InventoryModule,
    // Purchase cost and inventory valuation: super_admin only, by role.
    CostingModule,
    PricingModule,
    ReportsModule,
    DashboardModule,
    HealthModule,
    SeederModule,
  ],
  controllers: [],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    /*
     * ORDER MATTERS AND IS THE POINT. Guards run in registration order:
     * JwtAuthGuard authenticates and enforces the AUDIENCE, RolesGuard honours
     * any remaining legacy `@Roles`, and only then are CAPABILITIES checked.
     * So "right permission, wrong surface" is refused before the permission is
     * ever consulted, which is what keeps audience enforcement and permission
     * enforcement genuinely independent rather than one standing in for the
     * other.
     */
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
    // Without this the filter was dead code and errors fell back to Nest's
    // default shape, so success and error responses had different envelopes.
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}
