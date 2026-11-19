import { Module } from '@nestjs/common';
import { AuthService } from './services/auth.service';
import { UserModule } from 'src/modules/user/user.module';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { StorefrontOtpController } from './controllers/storefront-otp.controller';
import { StaffAccountController } from './controllers/staff-account.controller';
import { createSurfaceAuthController } from './controllers/surface-auth.controller';
import { AuthCookieService } from './services/auth-cookie.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Role } from './entities/role.entity';
import { Permission } from './entities/permission.entity';
import { RolePermission } from './entities/role-permission.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { RoleService } from './services/role.service';
import { RoleController } from './controllers/role.controller';
import { RbacController } from './controllers/rbac.controller';
import { RbacService } from './services/rbac.service';
import { CacheModule } from 'src/database/cache.module';
import { OtpChallenge } from './entities/otp-challenge.entity';
import { OtpService } from './services/otp.service';
import { OtpSender } from './services/otp-sender';
import { createOtpSender } from './services/otp-sender.factory';
import { RealtimeModule } from 'src/modules/realtime/realtime.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Role,
      Permission,
      RolePermission,
      RefreshToken,
      OtpChallenge,
    ]),
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET_KEY'),
      }),
    }),
    UserModule,
    CacheModule,
    /**
     * `AuthService.revokeAllSessions` ends the websockets as well as the
     * refresh rows. `RealtimeModule` depends on nothing in this module, so
     * there is no cycle.
     */
    RealtimeModule,
  ],
  controllers: [
    // One implementation per surface, generated from a single class so the
    // cookie, rotation and eligibility rules cannot drift between them.
    createSurfaceAuthController('storefront', {
      loginPath: 'review-login',
      reviewOnlyLogin: true,
    }),
    createSurfaceAuthController('admin', {
      loginPath: 'login',
      reviewOnlyLogin: false,
    }),
    createSurfaceAuthController('pos', {
      loginPath: 'login',
      reviewOnlyLogin: false,
    }),
    StorefrontOtpController,
    StaffAccountController,
    RoleController,
    RbacController,
  ],
  providers: [
    AuthService,
    AuthCookieService,
    RbacService,
    RoleService,
    JwtStrategy,
    OtpService,
    /**
     * SMS DELIVERY IS A PORT, bound here.
     *
     * `OtpSender` is an abstract class used as the injection token, so swapping
     * in a real gateway is a one-line change HERE and touches no OTP logic —
     * the cooldown, the rate limits, the attempt bound and the consumption
     * semantics all live in `OtpService` and are unaffected.
     *
     * The default binding records that a code was issued (masked number, in
     * non-production only) and DISCARDS the code. Every implementation is bound
     * by the contract on `OtpSender.send`: never log, trace or attach the code
     * to an error, a metric or a span.
     *
     * Chosen by `OTP_SMS_DRIVER` (`log` when unset, so existing deployments are
     * unchanged; `kavenegar` for real delivery). `validateEnv` has already
     * refused to boot on an invalid Kavenegar configuration.
     */
    {
      provide: OtpSender,
      inject: [ConfigService],
      useFactory: createOtpSender,
    },
  ],
  exports: [RbacService, AuthService],
})
export class AuthModule {}
