# kazhall-application

## Runtime

Node.js `^22.18.0 || >=24.11.0` (the `engines` field in `package.json`) and
pnpm 9. Each bound is a real requirement of the monorepo:

- **22.18.0** — the Web unit tests run `.ts` files directly with Node's
  built-in type stripping (`node --test lib/*.test.ts`), which is on by
  default only from 22.18. Node 20 and 22.17 install and build, but cannot
  run the test suite.
- **24.11.0** — typeorm requires `^20.19.0 || ^22.13.0 || >=24.11.0`.
- Next 16, Vite, Vitest and jsdom all accept this range.

Node 18 and 20 are not supported (both are past end of life). The API image
uses `node:22-alpine`.

## Local infrastructure

The canonical local Docker stack is the `kazhal-review` Compose project
(`apps/api/docker-compose.yml` + `apps/api/docker-compose.review.yml`). The
supported way to run it is `pnpm infra:*`, which calls `scripts/infra.sh`; the
script always selects `-p kazhal-review`.

| Command | What it does |
| --- | --- |
| `pnpm infra:up` | start PostgreSQL, Redis and MinIO and provision the `kazhal-products` bucket |
| `pnpm infra:ps` | show status |
| `pnpm infra:logs` | follow logs (`pnpm infra:logs minio` for one service) |
| `pnpm infra:stop` | stop the containers, keeping all data |

| Service | Address |
| --- | --- |
| PostgreSQL | `127.0.0.1:55433` (database `kazhal_review`) |
| Redis | `127.0.0.1:56379` |
| MinIO API | `http://localhost:59000`, bucket `kazhal-products` |
| MinIO console | `http://localhost:59001` |

`apps/api/.env.example` already points at these. The scripts never remove
containers or volumes.

**Use only `pnpm infra:*` for normal local development.** Direct
`docker compose` commands bypass that workflow, and nothing technically
prevents them from creating a separate stack: running
`apps/api/docker-compose.yml` on its own creates a project named `api` with
empty volumes on 5432/6379/9000, and passing a different `-p` (or setting
`COMPOSE_PROJECT_NAME`) with the review files creates another project with its
own empty volumes. The API is configured for neither.

A normal session is `pnpm infra:up`, then `pnpm dev`; stop with Ctrl-C, then
`pnpm infra:stop`.

## Local development ports

`pnpm dev` at the repository root starts the whole monorepo:

| App | Package | URL |
| --- | --- | --- |
| API (NestJS) | `@kazhal/api` | http://localhost:8000 (`/health`, Swagger at `/v1/api`) |
| Web — storefront and admin | `@kazhal/web` | http://localhost:8001 (admin at `/admin`) |
| Store — POS | `@kazhal/store` | http://localhost:8002 |

Port 3000 is deliberately not used by Kazhal.

Both frontends call the API and its Socket.IO gateway at `http://localhost:8000`
unless `NEXT_PUBLIC_API_BASE_URL` / `NEXT_PUBLIC_REALTIME_URL` are set. For
local development `apps/api/.env` needs
`CORS_ORIGINS=http://localhost:8001,http://localhost:8002` and
`PAYMENT_CALLBACK_URL=http://localhost:8001/checkout/payment/return`; see
`apps/api/.env.example`. `pnpm start` in each Next app serves a production build
on the same port as `pnpm dev`.

---

# Turborepo starter

This Turborepo starter is maintained by the Turborepo core team.

## Using this example

Run the following command:

```sh
npx create-turbo@latest
```

## What's inside?

This Turborepo includes the following packages/apps:

### Apps and Packages

- `docs`: a [Next.js](https://nextjs.org/) app
- `web`: another [Next.js](https://nextjs.org/) app
- `@repo/ui`: a stub React component library shared by both `web` and `docs` applications
- `@repo/eslint-config`: `eslint` configurations (includes `eslint-config-next` and `eslint-config-prettier`)
- `@repo/typescript-config`: `tsconfig.json`s used throughout the monorepo

Each package/app is 100% [TypeScript](https://www.typescriptlang.org/).

### Utilities

This Turborepo has some additional tools already setup for you:

- [TypeScript](https://www.typescriptlang.org/) for static type checking
- [ESLint](https://eslint.org/) for code linting
- [Prettier](https://prettier.io) for code formatting

### Build

To build all apps and packages, run the following command:

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed (recommended):

```sh
cd my-turborepo
turbo build
```

Without global `turbo`, use your package manager:

```sh
cd my-turborepo
npx turbo build
pnpm dlx turbo build
pnpm exec turbo build
```

You can build a specific package by using a [filter](https://turborepo.dev/docs/crafting-your-repository/running-tasks#using-filters):

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed:

```sh
turbo build --filter=docs
```

Without global `turbo`:

```sh
npx turbo build --filter=docs
pnpm exec turbo build --filter=docs
pnpm exec turbo build --filter=docs
```

### Develop

To develop all apps and packages, run the following command:

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed (recommended):

```sh
cd my-turborepo
turbo dev
```

Without global `turbo`, use your package manager:

```sh
cd my-turborepo
npx turbo dev
pnpm exec turbo dev
pnpm exec turbo dev
```

You can develop a specific package by using a [filter](https://turborepo.dev/docs/crafting-your-repository/running-tasks#using-filters):

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed:

```sh
turbo dev --filter=web
```

Without global `turbo`:

```sh
npx turbo dev --filter=web
pnpm exec turbo dev --filter=web
pnpm exec turbo dev --filter=web
```

### Remote Caching

> [!TIP]
> Vercel Remote Cache is free for all plans. Get started today at [vercel.com](https://vercel.com/signup?utm_source=remote-cache-sdk&utm_campaign=free_remote_cache).

Turborepo can use a technique known as [Remote Caching](https://turborepo.dev/docs/core-concepts/remote-caching) to share cache artifacts across machines, enabling you to share build caches with your team and CI/CD pipelines.

By default, Turborepo will cache locally. To enable Remote Caching you will need an account with Vercel. If you don't have an account you can [create one](https://vercel.com/signup?utm_source=turborepo-examples), then enter the following commands:

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed (recommended):

```sh
cd my-turborepo
turbo login
```

Without global `turbo`, use your package manager:

```sh
cd my-turborepo
npx turbo login
pnpm exec turbo login
pnpm exec turbo login
```

This will authenticate the Turborepo CLI with your [Vercel account](https://vercel.com/docs/concepts/personal-accounts/overview).

Next, you can link your Turborepo to your Remote Cache by running the following command from the root of your Turborepo:

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed:

```sh
turbo link
```

Without global `turbo`:

```sh
npx turbo link
pnpm exec turbo link
pnpm exec turbo link
```

## Useful Links

Learn more about the power of Turborepo:

- [Tasks](https://turborepo.dev/docs/crafting-your-repository/running-tasks)
- [Caching](https://turborepo.dev/docs/crafting-your-repository/caching)
- [Remote Caching](https://turborepo.dev/docs/core-concepts/remote-caching)
- [Filtering](https://turborepo.dev/docs/crafting-your-repository/running-tasks#using-filters)
- [Configuration Options](https://turborepo.dev/docs/reference/configuration)
- [CLI Usage](https://turborepo.dev/docs/reference/command-line-reference)
