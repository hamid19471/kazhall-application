import { Global, Module } from '@nestjs/common';
import { PermissionCatalogIntegrityService } from './permission-catalog-integrity.service';
import { PermissionService } from './permission.service';

/**
 * `@Global()`, for one structural reason.
 *
 * `AuthModule` imports `UserModule`, so `UserModule` cannot import
 * `AuthModule` back — and the user, cashier and branch screens all need the
 * same role-to-capability expansion that authentication needs. The options
 * were a `forwardRef` cycle, a second copy of the expansion, or lifting the
 * one service that has no dependencies of its own (it takes a `DataSource` and
 * nothing else) into a global module.
 *
 * Two copies of an authorisation primitive is how they drift apart, and a
 * `forwardRef` between the two largest modules in the application is a
 * maintenance trap. This is the smallest of the three.
 *
 * `PermissionCatalogIntegrityService` lives here too, and being in a global
 * module is what makes its `onModuleInit` run during the application's
 * bootstrap: a catalogue that does not match the code aborts startup before
 * the HTTP listener is bound, so no request is ever served by a process whose
 * authorisation table disagrees with its authorisation code.
 */
@Global()
@Module({
  providers: [PermissionService, PermissionCatalogIntegrityService],
  exports: [PermissionService, PermissionCatalogIntegrityService],
})
export class PermissionsModule {}
