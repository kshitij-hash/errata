#!/usr/bin/env bash
# deploy/railway/entrypoint.sh — first-boot setup for the Railway image. PID 1 until it execs
# supervisord. Adapted from deploy/pod/entrypoint.sh; everything that file refuses to start
# without is still refused here, plus one thing the pod never needed:
#
#   THE GRAPH IS NOT IN THE IMAGE AND NOT IN GIT.
#
# On RunPod the graph arrived on a network volume that already had data on it (ingest ran on the
# pod). Railway builds from a GitHub repo onto an EMPTY volume, so the first container to mount
# /data has no MinIO objects, no auth token and no lexicon — a running-but-empty system that
# answers every question with an abstention and looks fine in the logs. So: on a volume with no
# restore marker, this script pulls the packaged snapshot (scripts/package-snapshot.sh ->
# GitHub release), verifies every asset's sha256, unpacks it, and only then hands off. A
# checksum mismatch is fatal and loud — a half-restored object store fails much later and much
# more confusingly than an exit here does.
#
# The marker makes it once-per-volume, not once-per-boot: redeploys re-run this script against a
# volume that already holds the restored graph and skip straight to supervisord.
set -euo pipefail

DATA_ROOT="${ERRATA_DATA_ROOT:-/data}"
MARKER="$DATA_ROOT/.snapshot-restored"
# Staging lives on the EPHEMERAL disk, not the volume: the ~740 MB of archives are transient,
# and keeping them off /data is what lets the volume fit Railway Hobby's 5 GB cap.
STAGE="/tmp/.restore-staging"
CACHE_DIR="${GRAPH_DATA_CACHE_DIR:-/cache}"

log()  { printf '[entrypoint] %s\n' "$*"; }
fail() { printf '[entrypoint] FATAL: %s\n' "$*" >&2; exit 1; }

# --- hard rule: never CLOUD_PROVIDER=local for real data (CONVENTIONS.md / docs/gauntlets.md) ---------
if [ "${CLOUD_PROVIDER:-}" != "aws" ]; then
  fail "refusing to start — CLOUD_PROVIDER must be 'aws', got '${CLOUD_PROVIDER:-<unset>}'"
fi

# --- required secrets: real env at deploy time, never baked into the image -----------------------
# These must match the credentials the snapshot's MinIO data was written under: the restored
# .minio.sys carries the server's own config, and MinIO authenticates the graph-node client with
# exactly these values (entrypoint derives the AWS_* pair from them, as on the pod).
: "${MINIO_ROOT_USER:?entrypoint: MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?entrypoint: MINIO_ROOT_PASSWORD is required}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-$MINIO_ROOT_USER}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-$MINIO_ROOT_PASSWORD}"

# --- Railway injects PORT and health-checks that exact port on the container's own IP -----------
# apps/api/src/index.ts reads process.env.PORT ?? 8787 and binds HOST. Export both explicitly so
# supervisord's [program:api] can hand them down by name rather than by inheritance luck.
export PORT="${PORT:-8787}"
export HOST="${HOST:-0.0.0.0}"
log "API will bind ${HOST}:${PORT}"

mkdir -p "$DATA_ROOT/hydra" "$DATA_ROOT/minio" "$DATA_ROOT/lexicon" /var/log/supervisor
# LAW (measured, docs/gauntlets.md): the block cache must start EMPTY over restored objects — a
# stale cache is served in preference to the store and answers become a chimera of two graphs.
# The cache is ephemeral here, but a same-container restart keeps the fs, so wipe on EVERY boot:
# worst case is a cold start (~13 s to healthy, measured), never a chimera.
rm -rf "$CACHE_DIR"
mkdir -p "$CACHE_DIR"
log "wiped $CACHE_DIR (block cache always starts cold)"

# ------------------------------------------------------------------------------------------------
# first-boot restore
# ------------------------------------------------------------------------------------------------
restore_snapshot() {
  local urls shas url_arr sha_arr i url name f base
  urls="${SNAPSHOT_URLS:-}"
  shas="${SNAPSHOT_SHA256S:-}"

  if [ -z "$urls" ]; then
    # Not fatal: a deliberately empty deployment (ingest later, over Bolt) is a legitimate mode,
    # and the pod design supports it. But it is never what the demo wants, so say so loudly.
    log "WARNING: SNAPSHOT_URLS is unset — starting with an EMPTY graph."
    log "WARNING: /api/ask will abstain on every question until something is ingested."
    return 0
  fi
  [ -n "$shas" ] || fail "SNAPSHOT_URLS is set but SNAPSHOT_SHA256S is not — refusing an unverified restore"

  read -r -a url_arr <<< "$urls"
  read -r -a sha_arr <<< "$shas"
  [ "${#url_arr[@]}" -eq "${#sha_arr[@]}" ] \
    || fail "SNAPSHOT_URLS has ${#url_arr[@]} entries but SNAPSHOT_SHA256S has ${#sha_arr[@]} — they are positional"

  rm -rf "$STAGE"
  mkdir -p "$STAGE"

  for i in "${!url_arr[@]}"; do
    url="${url_arr[$i]}"
    name="$(basename "${url%%\?*}")"
    log "downloading ($((i + 1))/${#url_arr[@]}) $name"
    curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors --connect-timeout 20 \
      -o "$STAGE/$name" "$url" \
      || fail "download failed: $url"

    local got want
    got="$(sha256sum "$STAGE/$name" | awk '{print $1}')"
    want="${sha_arr[$i]}"
    if [ "$got" != "$want" ]; then
      fail "CHECKSUM MISMATCH for $name — expected $want, got $got. Refusing to restore a corrupt graph."
    fi
    log "  sha256 ok ($(wc -c < "$STAGE/$name" | tr -d ' ') bytes)"
  done

  # Assets over GitHub's 2 GB per-asset cap are uploaded as .partNN; put them back together in
  # name order (which is upload order, which is byte order — `split -d` guarantees it).
  shopt -s nullglob
  for f in "$STAGE"/*.part00; do
    base="${f%.part00}"
    log "reassembling $(basename "$base") from parts"
    cat "$base".part?? > "$base"
    rm -f "$base".part??
  done

  # The three archives carry their own top-level directory (minio/, hydra/, lexicon/), so each one
  # extracts into $DATA_ROOT and lands where it belongs regardless of order. Clear the targets
  # first: no marker means no verified data here, and a half-written previous attempt must not
  # survive underneath a good restore.
  rm -rf "$DATA_ROOT/minio" "$DATA_ROOT/hydra" "$DATA_ROOT/lexicon"
  for f in "$STAGE"/*.tar.zst; do
    log "unpacking $(basename "$f") -> $DATA_ROOT"
    zstd -dc "$f" | tar -C "$DATA_ROOT" -xf - || fail "unpack failed: $f"
  done
  shopt -u nullglob

  # Post-conditions. Each of these being absent is a silent-wrong-answer failure at query time.
  [ -d "$DATA_ROOT/minio/.minio.sys" ] || fail "restore produced no $DATA_ROOT/minio/.minio.sys — wrong archive layout"
  [ -d "$DATA_ROOT/minio/hydra" ]      || fail "restore produced no 'hydra' bucket under $DATA_ROOT/minio"
  [ -s "$DATA_ROOT/hydra/auth-token" ] || fail "restore produced no $DATA_ROOT/hydra/auth-token"
  ls "$DATA_ROOT"/lexicon/*.json >/dev/null 2>&1 || fail "restore produced no lexicon JSON under $DATA_ROOT/lexicon"

  rm -rf "$STAGE"
  {
    echo "restored_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "urls=$urls"
    echo "sha256s=$shas"
  } > "$MARKER"
  log "restore complete — marker written at $MARKER"
}

if [ -f "$MARKER" ]; then
  log "volume already restored ($(head -1 "$MARKER")) — skipping snapshot download"
else
  log "no restore marker at $MARKER — performing first-boot restore"
  restore_snapshot
fi

# 32-byte auth token: normally comes from the snapshot (the ingest CLI and any future ingest run
# must present the same one). Only generated here when there is no snapshot at all.
if [ ! -s "$DATA_ROOT/hydra/auth-token" ]; then
  head -c 24 /dev/urandom | base64 | tr -d '\n' > "$DATA_ROOT/hydra/auth-token"
  log "generated $DATA_ROOT/hydra/auth-token (no snapshot token present)"
fi

# The API reads the lexicon from ERRATA_LEXICON_DIR (apps/api/src/deps.ts -> config.lexiconDir,
# default 'var/lexicon' relative to CWD). The image points it at the volume; assert it, because a
# missing lexicon does not error — it degrades anchor resolution silently.
log "lexicon dir ${ERRATA_LEXICON_DIR:-<unset>}: $(ls "${ERRATA_LEXICON_DIR:-$DATA_ROOT/lexicon}" 2>/dev/null | grep -c '\.json$' || true) json files"

log "data root $DATA_ROOT ready, handing off to supervisord"
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/errata.conf -n
