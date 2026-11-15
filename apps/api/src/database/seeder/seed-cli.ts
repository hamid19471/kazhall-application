/**
 * Standalone seeder entrypoint — `pnpm seed`.
 *
 * Runs the same idempotent seeding as the application bootstrap hook, without
 * booting Nest (no HTTP server, no Redis, no S3). Safe to run repeatedly; a
 * second run creates nothing.
 *
 * IMPORTANT: `../data-source` must be the FIRST import. Loading it registers
 * tsconfig-paths, which is what makes the `src/...` imports inside
 * seeder.service.ts resolvable under plain `node -r ts-node/register`.
 */
import dataSource from '../data-source';
import { ConfigService } from '@nestjs/config';
import { SeederService } from './seeder.service';

async function main(): Promise<void> {
  await dataSource.initialize();

  try {
    const pending = await dataSource.showMigrations();
    if (pending) {
      throw new Error(
        'There are pending migrations. Run `pnpm migration:run` before seeding.',
      );
    }

    // SeederService only uses ConfigService.get(); a ConfigService built
    // straight from process.env behaves identically to the DI-provided one.
    const configService = new ConfigService(
      process.env as Record<string, unknown>,
    );
    const seeder = new SeederService(dataSource, configService);
    const result = await seeder.seed();

    process.stdout.write(
      `Seed complete.\n` +
        `  roles created : ${
          result.rolesCreated.length ? result.rolesCreated.join(', ') : 'none'
        }\n` +
        `  super_admin   : ${
          result.adminCreated
            ? 'created'
            : `not created (${result.adminSkippedReason ?? 'unknown'})`
        }\n`,
    );
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Seed failed: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
