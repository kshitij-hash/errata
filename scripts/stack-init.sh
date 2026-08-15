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

# .env is committed as .env.example only; ensure a real (possibly empty) .env exists so
# `docker compose --env-file .env` does not error when the user has not created one.
touch .env

# HydraDB's image runs as UID 10001; the bind mount is owned by you. Without matching uid/gid the
# first storage write fails. Update ONLY the HOST_UID/HOST_GID keys — never clobber other lines the
# user may have added to .env.local.
tmp="$(mktemp)"
grep -vE '^HOST_(UID|GID)=' .env.local 2>/dev/null > "$tmp" || true
{ cat "$tmp"; echo "HOST_UID=$(id -u)"; echo "HOST_GID=$(id -g)"; } > .env.local
rm -f "$tmp"

echo "stack-init ok — now run: docker compose --env-file .env --env-file .env.local up -d"
