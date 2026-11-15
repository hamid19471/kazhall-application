# Kazhal Web

The customer storefront and the admin console (`/admin`), built with Next.js.

## Getting started

Run everything from the repository root — this starts the API, Web and POS
together:

```bash
pnpm install
pnpm dev
```

This app is served at [http://localhost:8001](http://localhost:8001) (admin console at [/admin](http://localhost:8001/admin); payment return page at `/checkout/payment/return`).

## Configuration

| Variable | Default in development | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:8000` | API origin the browser calls. Set it for every non-local build — it is inlined at build time. |
| `NEXT_PUBLIC_REALTIME_URL` | the API base URL | Socket.IO origin, when it differs from the API. |
| `API_BASE_URL` / `REALTIME_URL` | unset | Server-only overrides (in-cluster hostnames); never sent to the browser. |

Precedence: explicit argument → `NEXT_PUBLIC_*` → server-only variable →
the `http://localhost:8000` development default.

The API must allow this origin: `CORS_ORIGINS` in `apps/api/.env` has to
include `http://localhost:8001` (see `apps/api/.env.example`).

## Local port contract

| App | Port |
| --- | --- |
| API | 8000 |
| Web (storefront and admin) | 8001 |
| POS | 8002 |

Port 3000 is not used by Kazhal. `pnpm build && pnpm start` in this directory
serves a production build on the same port 8001.
