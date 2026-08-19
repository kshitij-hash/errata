#!/usr/bin/env bash
# scripts/package-snapshot.sh — turn the verified graph snapshot into GitHub release assets that a
# fresh Railway container can restore on first boot (deploy/railway/entrypoint.sh).
#
# The graph is NOT in git: it is ~4 GB of MinIO objects plus the HydraDB auth token plus the
# ingest lexicon, and `backups/` is gitignored. Railway builds from a GitHub repo and has no
# registry image to bake data into, so the data has to arrive over the network at first boot. A
# public GitHub release is the cheapest durable host we already have — no S3 account, no signed
# URLs, and `gh release create` is one command.
#
# Three archives, one per restore target, each a tar whose members are prefixed with the directory
# name, so the container can `tar -C /data -xf` any of them in any order and land on
# /data/minio, /data/hydra, /data/lexicon.
#
# GitHub caps a single release asset at 2 GB, so anything over SPLIT_BYTES (1.9 GB, deliberately
# under the cap) is split into .partNN files. The entrypoint concatenates parts back in name order.
#
# Checksums are over the ASSETS AS UPLOADED (each part separately), because that is what the
# container can verify at the moment it has the bytes — verifying only the reassembled whole would
# mean a truncated part is not caught until after a 2 GB download plus a concatenation.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAPSHOT_DIR="${SNAPSHOT_DIR:-$REPO_ROOT/backups/listitem-20260818T192344Z}"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist-snapshot}"
RELEASE_TAG="${RELEASE_TAG:-graph-snapshot-v1}"
ZSTD_LEVEL="${ZSTD_LEVEL:-10}"
# GitHub's per-asset limit is 2 GB (2,000,000,000 in their docs' decimal sense as well as 2 GiB);
# 1.9 GB decimal is under both readings with room for the release API's own overhead.
SPLIT_BYTES="${SPLIT_BYTES:-1900000000}"

# The canonical restore set. Order matters only for readability; the entrypoint is order-agnostic.
COMPONENTS=(minio hydra lexicon)

log() { printf '[package-snapshot] %s\n' "$*" >&2; }
die() { printf '[package-snapshot] FATAL: %s\n' "$*" >&2; exit 1; }

command -v zstd >/dev/null || die "zstd not found (brew install zstd)"
command -v shasum >/dev/null || command -v sha256sum >/dev/null || die "no sha256 tool found"

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

[ -d "$SNAPSHOT_DIR" ] || die "snapshot dir not found: $SNAPSHOT_DIR"
for c in "${COMPONENTS[@]}"; do
  [ -d "$SNAPSHOT_DIR/$c" ] || die "snapshot is missing $c/ — refusing to package a partial graph"
done

# Refuse to package a HydraDB block cache. The cache directory is process-local state over the
# object store; restoring one on top of freshly restored objects serves chimera data (measured —
# docs/gauntlets.md). The entrypoint wipes /data/cache anyway; this is the second lock on the door.
[ -e "$SNAPSHOT_DIR/cache" ] && die "snapshot contains cache/ — a restored block cache serves stale reads; remove it"

# tar flavour: bsdtar (macOS) writes AppleDouble members and macOS xattrs (com.apple.provenance on
# anything downloaded) unless told not to. GNU tar in the container then logs a warning per member
# — noise that buries the real restore log. GNU tar has no such flags, so detect each one rather
# than assume, and this script runs on either.
TAR_FLAGS=()
for f in --no-mac-metadata --no-xattrs --no-acls --no-fflags; do
  if tar "$f" --version >/dev/null 2>&1; then TAR_FLAGS+=("$f"); fi
done

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

ASSETS=()

for c in "${COMPONENTS[@]}"; do
  base="errata-graph-$c.tar.zst"
  log "packing $c/ -> $base (zstd -$ZSTD_LEVEL)"
  # COPYFILE_DISABLE stops macOS tar from emitting ._ resource-fork members.
  COPYFILE_DISABLE=1 tar "${TAR_FLAGS[@]}" --exclude '.DS_Store' \
    -C "$SNAPSHOT_DIR" -cf - "$c" \
    | zstd -q -T0 "-$ZSTD_LEVEL" -o "$OUT_DIR/$base"

  whole_sha="$(sha256_of "$OUT_DIR/$base")"
  whole_size="$(wc -c < "$OUT_DIR/$base" | tr -d ' ')"
  log "  $base = $whole_size bytes"
  printf '%s  %s  (reassembled archive)\n' "$whole_sha" "$base" >> "$OUT_DIR/WHOLE-ARCHIVE-SHA256SUMS.txt"

  if [ "$whole_size" -gt "$SPLIT_BYTES" ]; then
    log "  > $SPLIT_BYTES bytes: splitting for GitHub's 2 GB per-asset cap"
    split -b "$SPLIT_BYTES" -d -a 2 "$OUT_DIR/$base" "$OUT_DIR/$base.part"
    rm -f "$OUT_DIR/$base"
    for p in "$OUT_DIR/$base.part"??; do ASSETS+=("$(basename "$p")"); done
  else
    ASSETS+=("$base")
  fi
done

# --- manifest -------------------------------------------------------------------------------------
MANIFEST="$OUT_DIR/SHA256SUMS.txt"
: > "$MANIFEST"
for a in "${ASSETS[@]}"; do
  printf '%s  %s\n' "$(sha256_of "$OUT_DIR/$a")" "$a" >> "$MANIFEST"
done

REPO_SLUG="${REPO_SLUG:-$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null \
  | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')}"
REPO_SLUG="${REPO_SLUG:-<owner>/<repo>}"
DL="https://github.com/$REPO_SLUG/releases/download/$RELEASE_TAG"

SNAPSHOT_URLS=""
SNAPSHOT_SHA256S=""
while read -r sha name; do
  SNAPSHOT_URLS="${SNAPSHOT_URLS:+$SNAPSHOT_URLS }$DL/$name"
  SNAPSHOT_SHA256S="${SNAPSHOT_SHA256S:+$SNAPSHOT_SHA256S }$sha"
done < "$MANIFEST"

# The two env values the Railway service needs, written to a file so they can be copy-pasted
# without re-deriving them by hand. Not a secret: the release is public and these are hashes.
cat > "$OUT_DIR/railway-snapshot-env.txt" <<EOF
# Paste into the Railway service variables (plain variables, NOT secrets — a public release URL
# and a list of checksums are not credentials). Order is significant: the Nth checksum verifies
# the Nth URL.
SNAPSHOT_URLS=$SNAPSHOT_URLS
SNAPSHOT_SHA256S=$SNAPSHOT_SHA256S
EOF

printf '\n'
log "artifacts in $OUT_DIR:"
( cd "$OUT_DIR" && ls -l . | tail -n +2 ) >&2
printf '\n'
cat >&2 <<EOF
================================================================================
1) Push the repo public first (a private repo's release assets need auth, and the
   container downloads them unauthenticated).

2) Create the release and upload every asset + the manifest:

gh release create $RELEASE_TAG \\
$(for a in "${ASSETS[@]}" "$(basename "$MANIFEST")"; do printf '  %s \\\n' "$OUT_DIR/$a"; done)
  --repo $REPO_SLUG \\
  --title "Errata graph snapshot (listitem-20260818T192344Z)" \\
  --notes "MinIO objects + HydraDB auth token + ingest lexicon for the verified list-item graph. Restored on first boot by deploy/railway/entrypoint.sh; checksums in SHA256SUMS.txt."

3) Set these two variables on the Railway service (also written to
   $OUT_DIR/railway-snapshot-env.txt):

SNAPSHOT_URLS=$SNAPSHOT_URLS

SNAPSHOT_SHA256S=$SNAPSHOT_SHA256S
================================================================================
EOF
