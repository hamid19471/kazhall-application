# Production container deployment

Kazhal ships three production application images:

| Image | Dockerfile | Internal port |
| --- | --- | --- |
| API | `apps/api/Dockerfile` | 8000 |
| Web storefront + Admin | `apps/web/Dockerfile` | 8001 |
| POS | `apps/store/Dockerfile` | 8002 |

The Next.js images use `output: "standalone"`; their runtime layers contain
only the traced server, static files and public assets. All three processes run
as the unprivileged `node` user. The API image contains production dependencies
and compiled migrations, but no development toolchain.

## Prepare configuration

```bash
cp .env.production.example .env.production
chmod 600 .env.production
```

Replace every placeholder. Public `NEXT_PUBLIC_*` values are embedded into the
browser bundles while the images are built, so changing them requires rebuilding
Web and POS. Secrets remain runtime environment variables and are not image build
arguments.

The current product-image model stores directly fetchable URLs. Therefore the
`kazhal-products` bucket is configured for anonymous download and
`S3_PUBLIC_BASE_URL` must be a browser-reachable HTTPS origin (normally a CDN or
reverse proxy mapped to that bucket). Do not deploy with an internal MinIO name
or `localhost` as that value.

Commercial Yekan Bakh files are deliberately excluded from the Docker build
context. The images use the bundled OFL-licensed Vazirmatn font. A licensee who
wants to ship the brand font must make that an explicit private-image build;
the public deployment path never copies untracked commercial binaries.

`ZIBAL_MERCHANT` is mandatory in the production environment. The application
has a sandbox fallback for development, but the production Compose file refuses
to render without an explicit merchant value.

## Validate and deploy

Always pass the production environment file explicitly:

```bash
docker compose --env-file .env.production \
  -f docker-compose.production.yml config --quiet

docker compose --env-file .env.production \
  -f docker-compose.production.yml build

docker compose --env-file .env.production \
  -f docker-compose.production.yml up -d
```

The one-shot `migrate` service must finish successfully before the API starts.
The one-shot `minio-init` service creates the bucket idempotently and applies
the public-download policy. An exited status of `0` for either service is
success.

Check the deployment:

```bash
docker compose --env-file .env.production \
  -f docker-compose.production.yml ps

curl --fail https://api.example.com/health
```

Stop application containers without deleting data:

```bash
docker compose --env-file .env.production \
  -f docker-compose.production.yml stop
```

Never add `-v` to a production `down` command: that deletes PostgreSQL, Redis
and MinIO volumes.

## Network and TLS boundary

PostgreSQL and Redis have no published host ports and live only on the internal
backend network. The MinIO console binds to loopback. Put a production reverse
proxy or load balancer with TLS in front of API, Web, POS and the MinIO public
asset endpoint. Restrict the raw published ports at the host firewall.

This Compose file is a single-host deployment reference. For a managed database,
managed Redis, external S3/CDN or an orchestrator, deploy the same three images
and provide equivalent runtime variables. Run the API image's migration command
as a release job before rolling out API replicas:

```bash
node node_modules/typeorm/cli.js \
  -d dist/database/data-source.js migration:run
```

Back up PostgreSQL and object storage before every production migration. Do not
run development seed or reset commands in production.
