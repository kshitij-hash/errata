#!/usr/bin/env bash
# scripts/stack-init.sh — idempotent; safe to run before every `docker compose up`.
# Creates the bind-mount dirs, the auth token, and writes HOST_UID/HOST_GID to .env.local
# so HydraDB's container (UID 10001) can write to a mount owned by you.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p .data/hydra .data/cache .data/minio backups

# 32-byte auth token, generated once, never committed (.data/ is gitignored)
if [ ! -f .data/hydra/auth-token ]; then
  head -c 24 /dev/urandom | base64 | tr -d '\n' > .data/hydra/auth-token
  echo "generated .data/hydra/auth-token"
fi

# HydraDB's image runs as UID 10001; the bind mount is owned by you. Without matching
# uid/gid the first storage write fails.
{ echo "HOST_UID=$(id -u)"; echo "HOST_GID=$(id -g)"; } > .env.local

echo "stack-init ok — now run: docker compose --env-file .env.local up -d"
