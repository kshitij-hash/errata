#!/usr/bin/env bash
# deploy/pod/entrypoint.sh — first-run setup for the pod image. Runs once per container start
# (container disk is wiped on every RunPod stop, so this must be idempotent) and then hands off to
# supervisord as PID 1. Runs as root: single-tenant pod, no bind-mount UID to match (unlike the
# local compose file, which runs HydraDB as HOST_UID to satisfy a host-owned bind mount).
set -euo pipefail

DATA_ROOT="${ERRATA_DATA_ROOT:-/data}"

# --- hard rule: never CLOUD_PROVIDER=local for real data (CLAUDE.md / docs/gauntlets.md) ---------
if [ "${CLOUD_PROVIDER:-}" != "aws" ]; then
  echo "entrypoint: refusing to start — CLOUD_PROVIDER must be 'aws', got '${CLOUD_PROVIDER:-<unset>}'" >&2
  exit 1
fi

# --- required secrets: must arrive as real env at pod-create time, never baked into the image ----
: "${MINIO_ROOT_USER:?entrypoint: MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?entrypoint: MINIO_ROOT_PASSWORD is required}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-$MINIO_ROOT_USER}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-$MINIO_ROOT_PASSWORD}"

# --- persistent dirs on the network volume (survive stop; container disk does not) ---------------
mkdir -p "$DATA_ROOT/hydra" "$DATA_ROOT/cache" "$DATA_ROOT/minio" "$DATA_ROOT/lexicon" /var/log/supervisor

# 32-byte auth token, generated once, then persisted on the volume so every future boot (and the
# host-side ingest CLI, which needs the same token over Bolt) reuses it instead of rotating it.
if [ ! -s "$DATA_ROOT/hydra/auth-token" ]; then
  head -c 24 /dev/urandom | base64 | tr -d '\n' > "$DATA_ROOT/hydra/auth-token"
  echo "entrypoint: generated $DATA_ROOT/hydra/auth-token"
fi

echo "entrypoint: data root $DATA_ROOT ready, handing off to supervisord"
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/errata.conf -n
