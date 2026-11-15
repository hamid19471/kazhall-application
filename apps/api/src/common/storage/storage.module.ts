import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ObjectDeletionService } from './object-deletion.service';
import { ObjectStorageService } from './object-storage.service';
import {
  resolveProductImageMaxBytes,
  resolveStorageConfig,
  type StorageResolution,
} from './storage.config';

/** Injection token for the validated upload ceiling, in bytes. */
export const PRODUCT_IMAGE_MAX_BYTES = 'PRODUCT_IMAGE_MAX_BYTES';

/** Exported for the fail-fast unit tests. */
export const STORAGE_RESOLUTION = 'STORAGE_RESOLUTION';

/**
 * ============================================================================
 * WHERE A MISSING STORAGE CONFIGURATION IS DECIDED.
 *
 * PRODUCTION REFUSES TO START. An API that cannot store a product image is
 * broken, and the failure it produces without this check is the worst kind:
 * everything looks healthy, every page renders, and one button in the Admin
 * console returns «خطای بحرانی» to whoever presses it. The deploy that
 * introduced the gap is long finished by the time anyone notices. So the
 * process dies at boot, naming every variable it needs, and the deployment
 * that is missing them never becomes the running one.
 *
 * DEVELOPMENT STARTS AND SAYS SO. The opposite call, for the opposite reason:
 * most work on this repository — orders, payments, reservations, the POS — has
 * nothing to do with images, and forcing every contributor to run MinIO before
 * the API will boot buys nothing. Uploads then answer a stable 503 whose
 * Persian sentence says the service is unavailable, instead of a 500 that
 * claims the server is broken.
 *
 * TEST behaves like development: the integration harness starts MinIO for the
 * specs that need it and leaves it absent for the ~980 that do not.
 * ============================================================================
 */
@Global()
@Module({
  providers: [
    {
      provide: STORAGE_RESOLUTION,
      inject: [ConfigService],
      useFactory: (config: ConfigService): StorageResolution => {
        const logger = new Logger('ObjectStorage');
        const read = (name: string) => config.get<string>(name);

        const resolution = resolveStorageConfig(read);
        const isProduction = config.get<string>('NODE_ENV') === 'production';

        if (resolution.legacyUsed.length > 0) {
          logger.warn(
            `Deprecated storage variables in use: ${resolution.legacyUsed.join(', ')}. ` +
              'Rename them to their S3_* equivalents (S3_ENDPOINT, S3_ACCESS_KEY, ' +
              'S3_SECRET_KEY, S3_BUCKET); the MINIO_* spellings are read only for ' +
              'compatibility and S3_* wins wherever both are set.',
          );
        }

        if (resolution.status === 'configured') {
          // Endpoint and bucket are not secrets and are exactly what an
          // operator needs to confirm they are pointed at the right place.
          // The keys are not logged, here or anywhere.
          logger.log(
            `Object storage ready [endpoint=${resolution.config.endpoint} ` +
              `bucket=${resolution.config.bucket} region=${resolution.config.region} ` +
              `pathStyle=${resolution.config.forcePathStyle} ` +
              `publicBase=${resolution.config.publicBaseUrl}]`,
          );
          return resolution;
        }

        const problems = [
          ...resolution.missing.map((name) => `missing ${name}`),
          ...resolution.invalid,
        ].join('; ');

        if (isProduction) {
          throw new Error(
            'Invalid object-storage configuration — refusing to start.\n' +
              `  ${problems}\n` +
              'Product image upload cannot work without these. See .env.example ' +
              '(section "object storage") for each variable and its meaning.',
          );
        }

        logger.warn(
          'PRODUCT IMAGE UPLOADS ARE UNAVAILABLE — object storage is not configured.\n' +
            `  ${problems}\n` +
            '  Uploads will answer 503 IMAGE_STORAGE_UNAVAILABLE until this is fixed.\n' +
            '  To start the documented local stack:\n' +
            '    docker compose -f apps/api/docker-compose.yml up -d minio minio-init\n' +
            '  then copy the object-storage block from .env.example into apps/api/.env.',
        );
        return resolution;
      },
    },
    {
      provide: ObjectStorageService,
      inject: [STORAGE_RESOLUTION],
      useFactory: (resolution: StorageResolution) =>
        new ObjectStorageService(resolution),
    },
    /*
     * The durable deletion lifecycle. Global alongside the storage service,
     * because both the catalogue (dropping an image from a product) and the
     * orphan sweeper hand it work, and neither should have to import a
     * products-specific module to do so.
     */
    ObjectDeletionService,
    {
      provide: PRODUCT_IMAGE_MAX_BYTES,
      inject: [ConfigService],
      useFactory: (config: ConfigService): number => {
        const resolved = resolveProductImageMaxBytes((name) =>
          config.get<string>(name),
        );
        if (resolved.status === 'invalid') {
          // Unconditional, in every environment: unlike a missing endpoint,
          // a malformed limit is never a deliberate "not using this locally".
          // It is a typo, and honouring the default instead would silently
          // enforce a number nobody wrote.
          throw new Error(
            `Invalid upload-size configuration — refusing to start.\n  ${resolved.reason}`,
          );
        }
        return resolved.maxBytes;
      },
    },
  ],
  exports: [
    ObjectStorageService,
    ObjectDeletionService,
    PRODUCT_IMAGE_MAX_BYTES,
    STORAGE_RESOLUTION,
  ],
})
export class StorageModule {}
