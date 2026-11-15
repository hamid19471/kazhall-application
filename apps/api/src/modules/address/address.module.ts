import { Module } from '@nestjs/common';
import { AddressService } from './address.service';
import { AddressController } from './address.controller';
import { CustomerAddressController } from './customer-address.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Address } from './entities/address.entity';
import { User } from 'src/modules/user/entities/user.entity';
import { UserModule } from '../user/user.module';

@Module({
  imports: [TypeOrmModule.forFeature([Address, User]), UserModule],
  controllers: [AddressController, CustomerAddressController],
  providers: [AddressService],
  exports: [AddressService],
})
export class AddressModule {}
