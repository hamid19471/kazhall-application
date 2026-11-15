#!/bin/sh
# Kazhal's one canonical local infrastructure: the `kazhal-review` Compose
# project (apps/api/docker-compose.yml + docker-compose.review.yml).
#
#   pnpm infra:up     start PostgreSQL 55433, Redis 56379, MinIO 59000/59001
#                     and (re)provision the kazhal-products bucket
#   pnpm infra:ps     status
#   pnpm infra:logs   follow logs
#   pnpm infra:stop   stop the containers, keeping every volume
#
# This script always selects `-p kazhal-review`, which is what makes it the
# safe workflow. Manual `docker compose` commands bypass it and must not be used
# for normal local development: apps/api/docker-compose.yml on its own creates a
# separate project named `api` (empty volumes on 5432, 6379 and 9000), and a
# different `-p` creates yet another. The API is configured for neither.
#
# There is deliberately no `down` and no `-v` here. Removing containers or
# volumes is a separate, explicit decision.
set -eu

cd "$(dirname "$0")/.."
compose() {
  docker compose -p kazhal-review \
    -f apps/api/docker-compose.yml \
    -f apps/api/docker-compose.review.yml "$@"
}

case "${1:-}" in
  up)
    # `--wait` on the long-running services only: Compose treats the one-shot
    # `minio-init` exiting as a failure of `--wait`, even with status 0.
    compose up -d --wait postgres redis minio
    compose up -d minio-init
    status=$(docker wait kazhal-review-minio-init)
    if [ "$status" != "0" ]; then
      echo "minio-init failed with exit code $status:" >&2
      compose logs minio-init >&2
      exit 1
    fi
    compose ps
    ;;
  ps) compose ps -a ;;
  logs) shift; compose logs -f --tail=100 "$@" ;;
  stop) compose stop ;;
  *)
    echo "usage: scripts/infra.sh up|ps|logs|stop" >&2
    exit 2
    ;;
esac
