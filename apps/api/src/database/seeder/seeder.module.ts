import { Module } from '@nestjs/common';
import { SeederService } from './seeder.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Role } from 'src/modules/auth/entities/role.entity';
import { User } from 'src/modules/user/entities/user.entity';

/**
 * Import this from AppModule. Until now it was declared but imported nowhere,
 * so `SeederService` was never instantiated and its bootstrap hook could not
 * have run even if it had not also been commented out.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Role, User])],
  providers: [SeederService],
  exports: [SeederService],
})
export class SeederModule {}
