# deploy/railway/Dockerfile — the Railway image: HydraDB + MinIO + the Hono API in ONE container,
# supervised, loopback-wired internally, one HTTP listener (the API, on Railway's injected $PORT).
#
# Same shape as deploy/pod/Dockerfile (that one is the tested RunPod build and stays as-is); the
# differences are all Railway's:
#
#   * Railway BUILDS this from the GitHub repo — there is no `docker push`, so every FROM must be
#     publicly pullable by Railway's builder. All three bases are public and pinned by digest, and
#     the HydraDB digest is the same one docker-compose.yml runs locally, so the engine that serves
#     the demo is byte-identical to the engine the snapshot was written by.
#   * Railway injects PORT and health-checks that port on the container's own IP. The API already
#     honours process.env.PORT (apps/api/src/index.ts); the entrypoint exports it and
#     supervisord's [program:api] passes it down by name.
#   * curl + zstd are installed: deploy/railway/entrypoint.sh restores the graph snapshot from a
#     GitHub release on first boot, which the pod never had to do (its volume already had data).
#   * GRAPH_DATA_CACHE_DIR is /cache — the container's EPHEMERAL disk, deliberately not the volume:
#     the cache is disposable by design (it must start cold over restored objects anyway), and
#     keeping it off /data lets the volume fit Railway Hobby's 5 GB cap (objects are 4.0 GB).
#   * GRAPH_DATA_CACHE_BYTES is 2 GiB, not the pod's 4 GiB — Railway bills actual usage on a box
#     around 8 GB, and 2 GiB is the value docker-compose.yml has run under for every eval and demo
#     to date. It is a measured working set, not a guess.
#
# Why the runtime stage is FROM the HydraDB image (not FROM node with graph-node copied in):
# `graph-node` dynamically links libgraphblas.so.7 (SuiteSparse GraphBLAS) and libgomp, neither of
# which is in a base Ubuntu install; building FROM the upstream image guarantees every shared
# library is exactly where it expects. The Node binary was checked the other way empirically and
# needs nothing beyond glibc/libstdc++, both already on the Ubuntu 24.04 base.

# ---- stage 1: compile @errata/api to plain JS and assemble its production dependency tree -------
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

# ---- stage 2: the runtime, built ON the HydraDB image (same digest as docker-compose.yml) --------
FROM ghcr.io/hydra-db/hydradb@sha256:db78309a233be54662db29744047e985a39b51c45a270d1a1f47c31a62cdb709 AS runtime
USER root
ENV DEBIAN_FRONTEND=noninteractive
# supervisor: the process trio. curl + zstd + ca-certificates: the first-boot snapshot restore
# (the upstream image ships none of them, and the restore is not optional on Railway).
RUN apt-get update \
 && apt-get install -y --no-install-recommends supervisor ca-certificates curl zstd \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build       /usr/local/bin/node /usr/local/bin/node
COPY --from=minio-src   /usr/bin/minio      /usr/bin/minio
COPY --from=mc-src      /usr/bin/mc         /usr/bin/mc
COPY --from=build       /out                /app

COPY deploy/railway/supervisord.conf /etc/supervisor/conf.d/errata.conf
COPY deploy/railway/entrypoint.sh    /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /var/log/supervisor

# --- gauntlet learnings baked in as image defaults (docs/gauntlets.md); every one is overridable
# by an explicit service variable, but the service must never start without them, so they are
# defaults here rather than only documented in a runbook a human can skip. ---
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
    GRAPH_DATA_CACHE_DIR=/cache \
    GRAPH_DATA_CACHE_BYTES=2147483648 \
    GRAPH_WRITER_LEASE_MS=120000 \
    GRAPH_AUTH_TOKEN_FILE=/data/hydra/auth-token \
    GRAPH_ALLOW_PLAINTEXT=true \
    HYDRA_BOLT_URL=bolt://127.0.0.1:7687 \
    HYDRA_TOKEN_FILE=/data/hydra/auth-token \
    ERRATA_DATA_ROOT=/data \
    ERRATA_LEXICON_DIR=/data/lexicon \
    PORT=8787 \
    HOST=0.0.0.0

# Documentation only on Railway (the platform routes to $PORT), and a real default for a local
# `docker run`. Bolt (7687) and the HydraDB admin port (9090) are never published.
EXPOSE 8787

ENTRYPOINT ["/entrypoint.sh"]
