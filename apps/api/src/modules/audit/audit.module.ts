import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminAuditLog } from './entities/admin-audit-log.entity';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';

/**
 * `@Global()` because almost every management module writes to the trail, and
 * threading one provider through a dozen `imports` arrays is how a module ends
 * up quietly NOT auditing because somebody forgot the import.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AdminAuditLog])],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
