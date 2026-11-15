import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import {
  AdminCashierController,
  AdminUserController,
} from './admin-user.controller';
import { AdminUserService } from './admin-user.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { Role } from '../auth/entities/role.entity';
import { Branch } from '../branch/entities/branch.entity';
import { Order } from '../orders/entities/order.entity';
import { RealtimeModule } from 'src/modules/realtime/realtime.module';

@Module({
  // `Order` is registered read-only here: `remove()` has to know whether a
  // staff member has sales before it decides between soft deactivation and a
  // hard delete. It does not create an import cycle (entity registration only).
  imports: [
    TypeOrmModule.forFeature([User, Role, Branch, Order]),
    RealtimeModule,
  ],
  controllers: [UserController, AdminUserController, AdminCashierController],
  providers: [UserService, AdminUserService],
  exports: [UserService, AdminUserService],
})
export class UserModule {}
