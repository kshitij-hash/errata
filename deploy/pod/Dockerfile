# deploy/pod/Dockerfile — the RunPod CPU pod image: HydraDB + MinIO + the Hono API in ONE
# container, supervised, loopback-wired internally, one HTTP port exposed.
#
# Why one image instead of the local docker-compose.yml: RunPod pods do not run Docker Compose and
# do not support Docker-in-Docker — a pod is a single pre-built image pulled from a registry, not a
# place that starts other containers. So the three services that are three compose services locally
# become three supervised processes in one image here.
#
# Why the runtime stage is FROM the HydraDB image (not FROM node, with graph-node's binary copied
# in): `graph-node` is dynamically linked against libgraphblas.so.7 (SuiteSparse GraphBLAS) plus
# libgomp — verified with `ldd /usr/local/bin/graph-node` inside the upstream image — and that
# library is not part of a base Debian/Ubuntu install. Lifting the binary alone risks a missing-.so
# crash that only shows up at container start, on the pod, tomorrow. Building FROM the upstream
# image instead guarantees every shared library graph-node needs is already exactly where it
# expects. The Node binary was checked the other way empirically (copied into the HydraDB image and
# run) and needs nothing beyond glibc/libstdc++, both already present on the Ubuntu 24.04 base.
#
# Build with --platform linux/amd64 for the real pod (RunPod CPU pods are x86_64); a local Apple
# Silicon build produces a linux/arm64 image, which is correct for LOCAL verification only.

# ---- stage 1: compile @errata/api to plain JS and assemble its production dependency tree -------
# Production never depends on Node's type-stripping path (that is a dev-loop convenience only).
FROM node:24.19.0-trixie-slim AS build
WORKDIR /src
RUN corepack disable 2>/dev/null || true; npm install -g pnpm@11.22.0

# Manifests first (layer caching), and pnpm needs package.json for every workspace member to
# resolve pnpm-lock.yaml even though only @errata/api and its dependency chain get built below.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/graph/package.json packages/graph/package.json
COPY packages/ingest/package.json packages/ingest/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/mcp/package.json packages/mcp/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

# Source for @errata/api and everything it references via TS project references.
COPY tsconfig.base.json tsconfig.json ./
COPY apps/api apps/api
COPY packages/core packages/core
COPY packages/graph packages/graph
COPY packages/ingest packages/ingest
COPY packages/llm packages/llm

RUN pnpm exec tsc -b apps/api --pretty false
# Self-contained production tree: @errata/api + its workspace deps, prod-only npm deps, no dev deps.
RUN pnpm deploy --filter @errata/api --prod --legacy /out

# config/models.json is read at runtime by relative path (apps/api/src/app.ts modelRoles()); it is
# not part of any package.json's published files, so pnpm deploy does not carry it — copy it in.
COPY config/models.json /out/config/models.json

# ---- stage refs: pull MinIO + mc by digest, purely so their binaries can be COPY --from'd --------
FROM minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e AS minio-src
FROM minio/mc@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727 AS mc-src

# ---- stage 2: the runtime, built ON the HydraDB image (see header comment) -----------------------
FROM ghcr.io/hydra-db/hydradb@sha256:db78309a233be54662db29744047e985a39b51c45a270d1a1f47c31a62cdb709 AS runtime
USER root
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends supervisor ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build       /usr/local/bin/node /usr/local/bin/node
COPY --from=minio-src   /usr/bin/minio      /usr/bin/minio
COPY --from=mc-src      /usr/bin/mc         /usr/bin/mc
COPY --from=build       /out                /app

COPY deploy/pod/supervisord.conf /etc/supervisor/conf.d/errata.conf
COPY deploy/pod/entrypoint.sh    /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /var/log/supervisor

# --- gauntlet learnings baked in as image defaults (docs/gauntlets.md); every one is overridable
# by an explicit env at `docker run`/pod-create time, but the pod must never be started without
# them, so they are defaults here rather than only documented in a runbook a human can skip. ---
ENV RUST_LOG=info \
    RUST_MIN_STACK=33554432 \
    CLOUD_PROVIDER=aws \
    AWS_REGION=us-east-1 \
    AWS_BUCKET=hydra \
    AWS_ENDPOINT=http://127.0.0.1:9000 \
    AWS_ALLOW_HTTP=true \
    GRAPH_NAMESPACE=default \
    GRAPH_ID=default \
    GRAPH_CELL_ID=cell-0 \
    GRAPH_CELLS=cell-0 \
    GRAPH_NODE_ID=node-0 \
    GRAPH_BOLT_NODE_ADDRESSES=node-0=0.0.0.0:7687 \
    GRAPH_ADVERTISED_BOLT_ADDR=127.0.0.1:7687 \
    GRAPH_DATA_CACHE_DIR=/data/cache \
    GRAPH_DATA_CACHE_BYTES=4294967296 \
    GRAPH_WRITER_LEASE_MS=120000 \
    GRAPH_AUTH_TOKEN_FILE=/data/hydra/auth-token \
    GRAPH_ALLOW_PLAINTEXT=true \
    HYDRA_BOLT_URL=bolt://127.0.0.1:7687 \
    HYDRA_TOKEN_FILE=/data/hydra/auth-token \
    ERRATA_DATA_ROOT=/data \
    ERRATA_LEXICON_DIR=/data/lexicon \
    PORT=8787 \
    HOST=0.0.0.0

# Only the API is proxied to the internet. Bolt (7687) and the HydraDB admin port (9090) are
# never listed here and must never be added to the pod's port list at create time.
EXPOSE 8787

ENTRYPOINT ["/entrypoint.sh"]
