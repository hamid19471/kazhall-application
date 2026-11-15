/**
 * Standalone TypeORM DataSource used by the CLI (`pnpm typeorm`,
 * `pnpm migration:run`, `pnpm migration:revert`, `pnpm migration:show`).
 *
 * The Nest application builds its own connection in `app.module.ts`; this file
 * exists so the migration tooling can run without booting Nest.
 *
 * `synchronize` is ALWAYS false here. Schema changes are expressed exclusively
 * as migrations under `src/migrations/` (see docs/ARCHITECTURE.md section 4).
 */
import 'reflect-metadata';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';

/**
 * The typeorm CLI is invoked as `node -r ts-node/register .../typeorm/cli.js`.
 * ts-node alone does not honour tsconfig `baseUrl` at *runtime*, so the
 * `src/...` style imports inside the entity files would fail to resolve while
 * the entity glob is being loaded. Registering tsconfig-paths here — before any
 * entity is required — fixes that without touching package.json scripts.
 *
 * Wrapped in try/catch so importing this module from a runner that already
 * handles resolution (jest, webpack) is harmless.
 */
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('tsconfig-paths/register');
} catch {
  /* resolution already handled by the host runner */
}

/**
 * Minimal `.env` reader. We deliberately do NOT depend on `dotenv` directly:
 * it is only a transitive dependency of @nestjs/config and is not resolvable
 * from this package under pnpm's strict node_modules layout.
 * Values already present in process.env always win.
 */
function loadDotEnv(file = join(process.cwd(), '.env')): void {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

export const dataSourceOptions = {
  type: 'postgres' as const,
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'postgres',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_DATABASE ?? 'kazhal',
  entities: [__dirname + '/../**/entities/*.entity{.ts,.js}'],
  migrations: [__dirname + '/../migrations/*{.ts,.js}'],
  migrationsTableName: 'migrations',
  synchronize: false,
  logging: process.env.TYPEORM_LOGGING === 'true',
};

const dataSource = new DataSource(dataSourceOptions);

export default dataSource;
