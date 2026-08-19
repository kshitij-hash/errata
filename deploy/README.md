# Deployment — runbooks

Two targets are documented here, in the order they matter today:

- **Part 1 — Railway.** The deploy that ships. Builds the image from the GitHub repo, restores the
  graph onto a volume on first boot, serves the API on Railway's injected `$PORT`.
- **Part 2 — RunPod.** The earlier design, fully tested end-to-end locally.
  It is kept verbatim as the fallback and as the source of every gauntlet mitigation Part 1
  inherits. Nothing in it was changed to make room for Railway.

Everything here is standalone: it does not reference any external planning document, and nothing
in this tree needs anything outside this repo to be actioned.

## What ships

```
deploy/
├── README.md                  this file
├── railway/
│   ├── Dockerfile              multi-stage build: HydraDB + MinIO + the Hono API in ONE image
│   ├── entrypoint.sh           first-boot SNAPSHOT RESTORE, then hands off to supervisord
│   ├── supervisord.conf        the three supervised processes, + explicit PORT passthrough
│   └── env.railway.example     env var NAMES only, every value empty — never fill in and commit
└── pod/
    ├── Dockerfile              the RunPod image (unchanged)
    ├── entrypoint.sh           idempotent first-boot setup, then hands off to supervisord
    ├── supervisord.conf        the three supervised processes + their startup ordering
    └── env.pod.example         env var NAMES only, every value empty

railway.json                    repo root — Railway reads it at build/deploy time
scripts/package-snapshot.sh     turns backups/<snapshot>/ into GitHub release assets + checksums
```

`.dockerignore` (repo root) keeps the build context to committed source only — it also excludes
`dist-snapshot/`, so the 737 MB of release assets never enter a build context.

---

# Part 1 — Railway (the deploy that ships)

## What is different from the pod, and why

| | RunPod | Railway |
|---|---|---|
| Image | you `docker buildx build --platform linux/amd64` and push to a registry | Railway builds `deploy/railway/Dockerfile` from the GitHub repo; no registry, no push, no platform flag (their builder is x86_64) |
| Port | fixed `8787`, listed in the pod's port map | Railway **injects `PORT`** and health-checks that exact port on the container's own IP; the API already honours `process.env.PORT` (`apps/api/src/index.ts`) |
| Data | network volume that already had the graph on it (ingest ran on the pod) | volume mounts **empty**; the graph is downloaded and verified on first boot |
| Cache ceiling | `GRAPH_DATA_CACHE_BYTES=4294967296` (4 GiB) on a 16 GB box | `2147483648` (2 GiB) — Railway bills actual usage on a ~8 GB box, and 2 GiB is the value `docker-compose.yml` has run under for every eval and demo to date |
| Stop | container stop-timeout could be set to 60 s | grace between SIGTERM and SIGKILL is **0 s by default** — see *Stop behaviour* below |

Everything else is the pod design unchanged: one image, three supervised processes, MinIO and
HydraDB on loopback, the API as the only listener, and every gauntlet mitigation baked in as an
image `ENV` an operator would have to actively override to lose.

## Topology

```
                        Railway edge (TLS, *.up.railway.app)
                                   |
                                   v
                        :$PORT  Hono API  (0.0.0.0 — the ONLY listener)
                                   |
                    127.0.0.1:7687 (Bolt)      127.0.0.1:9000 (S3)
                                   |                    |
                              HydraDB  ------------->  MinIO
                        (admin :9090, never exposed)
```

MinIO binds `127.0.0.1` here rather than the pod's `0.0.0.0`: on Railway every service in a project
shares a private network, so the object store is reachable only by the two processes beside it.

## The graph is not in the image and not in git

`backups/` is gitignored and the snapshot is ~4 GB — it cannot ride in the repo, and Railway has no
registry image to bake it into. So `deploy/railway/entrypoint.sh` restores it on first boot:

1. no `/data/.snapshot-restored` marker → download every URL in `SNAPSHOT_URLS` (space-separated,
   split parts supported),
2. verify each downloaded file's sha256 against the positionally matching entry in
   `SNAPSHOT_SHA256S` — **a mismatch is fatal**: it logs `FATAL: CHECKSUM MISMATCH …` and exits 1
   rather than starting on a corrupt object store,
3. reassemble any `.partNN` files, unpack into `/data/minio`, `/data/hydra`, `/data/lexicon`,
4. **wipe `/data/cache`** — HydraDB's block cache must be cold over restored objects; a warm cache
   from a different object set is served *in preference to* the objects and the answers come back
   as a chimera of two graphs (measured; `docs/gauntlets.md`),
5. write the marker.

Marker present → skip straight to supervisord. That is what makes a redeploy cheap and a restore
once-per-volume rather than once-per-boot.

**Footgun:** changing `SNAPSHOT_URLS` on a service whose volume already has the marker does
nothing. To force a re-restore you must delete `/data/.snapshot-restored` (via `railway ssh`) or
detach and recreate the volume.

## Gauntlet mitigations baked into the image

| Finding | Where it's fixed |
|---|---|
| `graph-node` aborts on the first query without a 32 MiB thread stack | `RUST_MIN_STACK=33554432`, image `ENV` in `deploy/railway/Dockerfile` |
| Writer-lease churn on write-idle re-opens SlateDB and leaks ~200 MB per re-open, ratcheting RSS to OOM | `GRAPH_WRITER_LEASE_MS=120000`, image `ENV` |
| Default `GRAPH_DATA_CACHE_BYTES` (8 GiB) exceeds a modest container's headroom | `GRAPH_DATA_CACHE_BYTES=2147483648` (2 GiB), image `ENV` |
| `CLOUD_PROVIDER=local` silently drops writes under load | `entrypoint.sh` refuses to start unless `CLOUD_PROVIDER=aws`; the image also bakes `aws` |
| Upstream image ships no `curl`/`wget`/`nc` | the Dockerfile installs `curl`/`zstd` for the restore; every internal wait probe still uses bash's own `/dev/tcp` |
| A restored graph under a stale block cache serves chimera data | `entrypoint.sh` wipes `/data/cache` on restore; `package-snapshot.sh` refuses to package a `cache/` directory at all |
| The upstream image SIGKILLs `graph-node` ~1 s after SIGTERM, before it can release the writer lease | `supervisord.conf`: `stopsignal=TERM stopwaitsecs=58` — but see *Stop behaviour* |

## Verified locally before this was written

Built `deploy/railway/Dockerfile` on this machine (Apple Silicon → `linux/arm64`; Railway's builder
produces `linux/amd64` itself, which is the one difference this test cannot cover). Image: **881 MB**.

Ran it as `errata-railwaydry` on a **fresh empty Docker volume**, with `PORT=8080` set deliberately
to a non-default value and `SNAPSHOT_URLS` pointed at a `python -m http.server` serving the real
packaged artifacts. **The dev stack containers (`errata-hydradb-1`, `errata-minio-1`,
`errata-minio-init-1`) were never started, stopped or touched** — confirmed by `docker ps -a` before
and after. Observed, in order:

1. **Restore** — three downloads, three `sha256 ok` lines, unpack, `wiped /data/cache`, marker
   written. `/health` returned 200 **13 s after container start** (local HTTP server; on the real
   deploy this is download-bandwidth bound instead).
2. **PORT passthrough** — `errata-api listening on http://0.0.0.0:8080`, i.e. the injected value,
   not the image's `8787` default.
3. **Lexicon wiring** — `lexicon dir /data/lexicon: 172 json files`, and `GET /api/meta` lists all
   172 ingested history ids (the API reads them from `ERRATA_LEXICON_DIR`).
4. **HydraDB up on restored data** — `GET /api/meta/health?history_id=852ce960-clean` →
   `{"readyz":true,"node_counts":{"Speaker":2,"Turn":396,"Session":39,…}}`.
5. **The demo answer** — `POST /api/ask {"question":"How much was I pre-approved for?"}` →
   **`$425,000`**, first citation `session_id: "user-correction"`, span
   `"corrected by the user to $425,000"`, with the `$400,000` → `$350,000` supersession chain
   underneath it.
6. **The write gate** — `POST /api/correction` with no key → **401**; with a wrong key → **401**;
   with the right key → the route runs (a probe for a subject that does not exist returned 404 from
   the handler, not the gate).
7. **The debug trace is off** — `"debug": true` produced no `trace` key.
8. **Checksum mismatch fails loudly** — a run with a deliberately wrong hash printed
   `FATAL: CHECKSUM MISMATCH …`, **exited 1**, and left **no marker** on the volume, so the next
   boot retries the restore rather than serving a half-restored graph.
9. **Marker skip** — a restart logged `volume already restored (restored_at=…) — skipping snapshot
   download` and was serving again in seconds, no re-download.
10. **Ungraceful stop** (`docker kill`, i.e. Railway's 0 s grace, worst case) — on restart `/health`
    was 200 in **4 s**, `/api/ask` still answered `$425,000`, and a real `POST /api/correction`
    **succeeded in 485 ms** — no `cell not owned by this node` lease shadow. SlateDB recovered from
    the SIGKILL on its own.
11. Torn down: `docker rm -f errata-railwaydry`, both scratch volumes removed.

Not covered by any of this: Railway's own builder, its edge/TLS, its healthcheck, its volume, and
the real GitHub-release download path. Those are first exercised on the real deploy.

## Deploy, in order

### 0. Prerequisites

- The GitHub repo **public** (the container downloads release assets unauthenticated).
- A Railway account. The deployment fits the **Hobby plan's 5 GB volume cap by design**: only the
  ~4.0 GB of durable state lives on the volume, while the block cache (2 GiB ceiling) and the
  transient restore staging stay on the container's ephemeral disk — see step 5 for the sizing.
- `gh` authenticated locally, and `zstd` installed (`brew install zstd`) for the packaging script.

### 1. Push the repo public

```bash
git push origin main            # then flip visibility to public in the GitHub UI
```

### 2. Package the snapshot

```bash
./scripts/package-snapshot.sh
```

Reads `backups/listitem-20260818T192344Z/{minio,hydra,lexicon}`, writes zstd archives plus
`SHA256SUMS.txt` into the gitignored `dist-snapshot/`, and prints the exact `gh release create`
command and the two env values to paste into Railway (also written to
`dist-snapshot/railway-snapshot-env.txt`). Anything over 1.9 GB is split into `.partNN` assets for
GitHub's 2 GB per-asset cap; at the measured sizes nothing splits.

### 3. Create the release

Run the `gh release create graph-snapshot-v1 …` command the script printed, verbatim. It uploads the
three archives and the manifest to the tag `graph-snapshot-v1`.

### 4. Create the Railway service

New Project → **Deploy from GitHub repo** → this repo. `railway.json` at the repo root is picked up
automatically:

```json
{ "build":  { "builder": "DOCKERFILE", "dockerfilePath": "deploy/railway/Dockerfile" },
  "deploy": { "healthcheckPath": "/health", "healthcheckTimeout": 900,
              "restartPolicyType": "ON_FAILURE", "restartPolicyMaxRetries": 10 } }
```

`healthcheckTimeout` is 900 s rather than the 300 s default **because the first boot restores ~4 GB
before the API binds** — the download is the variable, and a deploy that is still restoring must not
be marked failed.

### 5. Attach the volume BEFORE the first deploy

Service → **Data / Volumes** → mount path **`/data`**, size **5 GB** (the Hobby-plan maximum —
and enough, by design). Volumes are mounted at container start, not at build, and a first boot
without one restores 4 GB onto the ephemeral container disk and loses it on the next deploy.

Sizing: the volume holds only the durable state — 4.0 GB of MinIO objects + 22 MB lexicon + the
LLM ledger + whatever corrections judges append (kilobytes). The block cache (up to 2 GiB) and the
~740 MB of transient restore staging both live on the container's EPHEMERAL disk on purpose: the
cache must start cold anyway and the staging is deleted after unpack, so neither earns volume
space, and keeping them off `/data` is what lets the whole deployment fit the Hobby plan. Peak
volume usage ≈ 4.1 GB of 5 GB. Volumes can be grown later but never shrunk.

### 6. Set the variables

| Var | Kind | Value / notes |
|---|---|---|
| `MINIO_ROOT_USER` | **Secret** | **Required.** Must match the credentials the snapshot's MinIO data was written under (the snapshot carries `.minio.sys`). `entrypoint.sh` derives `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` from it — do not set those separately. |
| `MINIO_ROOT_PASSWORD` | **Secret** | **Required.** Same. |
| `SNAPSHOT_URLS` | plain | **Required.** Space-separated release asset URLs, from the packaging script. |
| `SNAPSHOT_SHA256S` | plain | **Required.** Space-separated sha256s, **positionally matched** to `SNAPSHOT_URLS`. Not a secret — they are hashes of public files. |
| `OPENROUTER_API_KEY` | **Secret** | **Required for the published behaviour.** Without it `/api/ask` does not fail — it silently degrades to the deterministic fold, which measures **8.3 overall against the 60.0 in `eval/RESULTS.md`**. A judge would be measuring a different system. |
| `ERRATA_BUDGET_CAP` | plain | Set it alongside the key. Hard cap on **cumulative** USD ledger spend; default 50. The API seeds its running total from the on-disk ledger at startup (`apps/api/src/deps.ts`), so it does not re-arm at zero on every restart. |
| `ERRATA_WRITE_KEY` | **Secret** | **Required.** Gates `POST /api/correction`, the only route that writes. **Unset means the route is OPEN** (fail-open unconfigured, closed when configured — `apps/api/src/auth.ts`). Use the *same value* in the Vercel project. |
| `ERRATA_DEMO_HISTORY` | plain | `852ce960-clean` — which history the `/api/*` routes default to. |
| `GRAPH_DATA_CACHE_BYTES` | plain | Only to override the image's 2 GiB. Leave unset unless you are deliberately resizing the box. |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | plain | `60`. Default is **0** — see *Stop behaviour*. |
| `ERRATA_DEBUG_OK` | — | **NEVER SET THIS.** `=1` makes `POST /api/ask` honour `"debug": true`, returning the verbatim evidence spans of every ranked claim plus a bounded scan of the history's claims, to any caller who asks for it. It belongs on a dev box and on whatever host replays `eval/failure_review.py`. |
| `PORT` | — | **Do not set.** Railway injects it and health-checks that port. |
| `ERRATA_TAU`, `ERRATA_MATERIAL_MAX` | plain | Optional answer-path tuning; both have working defaults. |
| `GIT_SHA`, `ERRATA_CORPUS_REVISION` | plain | Optional; surfaced read-only by `GET /api/meta`. |

Everything else — `RUST_MIN_STACK`, `CLOUD_PROVIDER`, `GRAPH_WRITER_LEASE_MS`, the
`AWS_ENDPOINT`/`AWS_BUCKET`/`AWS_REGION` triple, the bind addresses, `ERRATA_LEXICON_DIR`, `HOST` —
is already an image default in `deploy/railway/Dockerfile`. Names-only copy:
`deploy/railway/env.railway.example`.

### 7. Deploy, and watch the first boot

Nothing to run by hand. The build takes a few minutes; then the log should read, in order:

```
[entrypoint] API will bind 0.0.0.0:<PORT>
[entrypoint] no restore marker at /data/.snapshot-restored — performing first-boot restore
[entrypoint] downloading (1/3) errata-graph-minio.tar.zst
[entrypoint]   sha256 ok (773085167 bytes)
…
[entrypoint] wiped /data/cache (block cache must be cold over a restored object store)
[entrypoint] restore complete — marker written at /data/.snapshot-restored
[entrypoint] lexicon dir /data/lexicon: 172 json files
… supervisord … minio … Bucket created successfully `m/hydra` … graph node listeners started …
errata-api listening on http://0.0.0.0:<PORT>
```

If instead you see `FATAL: CHECKSUM MISMATCH` the deploy stops there on purpose: re-check that
`SNAPSHOT_SHA256S` is in the same order as `SNAPSHOT_URLS`, and that the release assets uploaded
completely.

### 8. Verify from outside, not from the dashboard

```bash
BASE=https://<your-service>.up.railway.app
curl -sS "$BASE/health" -w ' [%{http_code}]\n'
curl -sS "$BASE/api/meta/health?history_id=852ce960-clean" -w ' [%{http_code}]\n'
curl -sS -X POST "$BASE/api/ask" -H 'content-type: application/json' \
  -d '{"question":"How much was I pre-approved for?","history_id":"852ce960-clean"}'
```

The third must answer `$425,000` with `session_id: "user-correction"` as the first citation — a real
round-tripped answer off the restored graph, not just the liveness ping.

Then the three hardening gates, each of which fails *silently in the unsafe direction* if the
variables were wrong:

```bash
# the write gate is CLOSED — this must be 401, not 201. A 201 means ERRATA_WRITE_KEY is unset
# and you have just appended a real claim to the demo history (there is no undo).
curl -sS -o /dev/null -w 'no key -> %{http_code}\n' -X POST "$BASE/api/correction" \
  -H 'content-type: application/json' \
  -d '{"subject":"probe","attribute":"probe","value":"probe"}'          # expect 401

# the answer path is the PUBLISHED one, not the fold: expect "errata-graph-synthesis@2".
# "errata-graph-fold@1" means OPENROUTER_API_KEY did not reach the service.
curl -sS "$BASE/api/meta" | grep -o '"answer_mechanism":"[^"]*"'

# the debug trace is OFF: the response must carry no `trace` key.
curl -sS -X POST "$BASE/api/ask" -H 'content-type: application/json' \
  -d '{"question":"How much was I pre-approved for?","debug":true}' | grep -c '"trace"'   # expect 0
```

The correction probe is deliberately written to be refused. Do **not** re-run it with the real key
"just to check the happy path": it appends a junk claim to the demo history, and the append-only
invariant means the only way back is another correction on top of it.

### 9. Wire Vercel

In the Vercel project (`apps/web`):

| Var | Value |
|---|---|
| `ERRATA_API_URL` | `https://<your-service>.up.railway.app` — no trailing slash |
| `ERRATA_WRITE_KEY` | **the same value** as on Railway |

The browser never sees the secret: the proxy (`apps/web/app/api/errata/[...path]/route.ts`) injects
the header server-side, and requires an `Origin` header on POSTs so it cannot be used as an open
relay that attaches the write key for a stranger. Redeploy the Vercel project after setting them.

## Stop behaviour — the honest caveat

`supervisord.conf` gives `graph-node` up to **58 s** after SIGTERM to flush and release its writer
lease. **Railway's default grace between SIGTERM and SIGKILL is 0 seconds**, which is shorter than
both that and the 60 s the pod design wanted. Setting `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=60`
closes most of the gap, but a redeploy or platform-initiated move can still cut the node off
mid-flush.

What makes that survivable rather than fatal, honestly stated:

- the volume holds a **restored snapshot**, and the canonical copy remains
  `backups/listitem-20260818T192344Z/` plus the GitHub release — nothing on Railway is the only copy;
- **SlateDB recovers from ungraceful stops.** Measured locally: `docker kill` (a hard SIGKILL, i.e.
  worse than Railway's default), then restart → `/health` 200 in 4 s, `/api/ask` unchanged, and a
  real correction write succeeded 485 ms later with no `cell not owned by this node` lease shadow;
- a re-deploy re-runs a clean boot, and if a volume is ever genuinely wrecked, deleting the marker
  (or the volume) re-restores from the release in minutes.

This is a mitigation, not a fix. The pod design's 58 s window is the thing Railway cannot promise.

## Redeploy, and re-restoring

Push to the connected branch; Railway rebuilds and restarts. The volume — and its marker — survive,
so a redeploy does **not** re-download the graph. To deliberately re-restore: `railway ssh` into the
service and `rm /data/.snapshot-restored`, then restart; or detach and recreate the volume.

## Unresolved — could bite during the real deploy

- **The build is Railway's, not ours.** Everything above was verified on a local `linux/arm64`
  build; Railway's builder produces `linux/amd64` from the same Dockerfile. All three base images
  are public and pinned by digest — the HydraDB digest is the same one `docker-compose.yml` runs —
  but the amd64 variants of those digests have not been run by us.
- **The real download path.** Restore was verified against a local HTTP server, not against
  `github.com/.../releases/download/...`. Release assets on a public repo are unauthenticated
  redirects to `objects.githubusercontent.com`; `curl -fsSL` follows them, and the entrypoint
  retries 5 times — but GitHub's rate limits and redirect behaviour under a cold Railway egress IP
  are untested.
- **`healthcheckTimeout: 900` vs a slow first boot.** If GitHub serves the 737 MB slowly, the first
  deploy can still be marked failed. The restore is idempotent and the marker is only written on
  success, so the retry simply resumes from scratch — but it will look like a failed deploy first.
- **Plan limits.** A Hobby-plan volume (5 GB max) cannot hold this graph. Confirm the plan before
  the deploy, not after the restore fills the disk.
- **`ERRATA_DEBUG_OK` and `eval/failure_review.py`.** That script needs the debug trace; run it
  against a local or dev API with `ERRATA_DEBUG_OK=1`, never against Railway. The scoring harness
  (`eval/errata_eval/arms.py`) sends no `debug` field, so a full eval run against the deployed URL
  is unaffected.
- **Ingest is not in the image.** As on the pod, the image ships the API server only. Bolt is never
  exposed, so any future ingest must run from inside the container (`railway ssh`) against
  `bolt://127.0.0.1:7687`, with `--lexicon-dir /data/lexicon`.

---

# Part 2 — RunPod (the tested alternative)

This is the deploy design that was built and verified end-to-end locally first, and
it is unchanged. It is not what ships today — Part 1 is — but it is the fallback if Railway is a
dead end, and it is where every gauntlet mitigation Part 1 inherits was first worked out. Read
"pod" as RunPod throughout; the `deploy/pod/` tree it describes still exists exactly as written.

## What ships

```
deploy/
└── pod/
    ├── Dockerfile              multi-stage build: HydraDB + MinIO + the Hono API in ONE image
    ├── entrypoint.sh           idempotent first-boot setup, then hands off to supervisord
    ├── supervisord.conf        the three supervised processes + their startup ordering
    └── env.pod.example         env var NAMES only, every value empty — never fill this in and commit it
```

`.dockerignore` (repo root) keeps the build context to committed source only.

## Why one image, not the local `docker-compose.yml`

RunPod pods run a single pre-built image pulled from a registry — they do not run Docker Compose
and do not support Docker-in-Docker, so a pod cannot start three containers the way the local
compose stack does. `deploy/pod/Dockerfile` collapses the three compose services (`minio`,
`hydradb`, the API) into three processes supervised inside one image instead. The local
`docker-compose.yml` is untouched — it is still what you run on a laptop.

## Topology

```
                         RunPod HTTP proxy (free TLS)
                                   |
                                   v
                         :8787  Hono API  (0.0.0.0 — the ONLY port exposed)
                                   |
                    127.0.0.1:7687 (Bolt)      127.0.0.1:9000 (S3)
                                   |                    |
                              HydraDB  ------------->  MinIO
                        (admin :9090, never exposed)
```

Bolt (7687) and the HydraDB admin port (9090) are bound inside the container but are never in the
pod's port list — the only thing RunPod's proxy can reach is 8787. This matches the repo rule that
HydraDB is never directly internet-reachable.

## Gauntlet mitigations baked into the image

Each of these is a `docs/gauntlets.md` finding, and each is now a default an operator would have to
actively override to lose — not a runbook step that can be skipped under deadline pressure.

| Finding | Where it's fixed |
|---|---|
| `graph-node` aborts on the first query without a 32 MiB thread stack | `RUST_MIN_STACK=33554432`, baked as an image `ENV` in `deploy/pod/Dockerfile` |
| The upstream image's default stop behaviour SIGKILLs before the writer lease is released | `deploy/pod/supervisord.conf`: `[program:hydradb]` sets `stopsignal=TERM stopwaitsecs=58`, so supervisord itself waits up to 58s before escalating. Verified locally — see below. |
| Writer-lease churn on write-idle re-opens SlateDB and leaks ~200MB per re-open, ratcheting RSS to OOM | `GRAPH_WRITER_LEASE_MS=120000`, baked as an image `ENV` — outlives the write gaps between ingest bursts |
| `CLOUD_PROVIDER=local` silently drops writes under load | `entrypoint.sh` refuses to start unless `CLOUD_PROVIDER=aws`; the image also bakes `CLOUD_PROVIDER=aws` as the default so it takes an explicit override to break |
| The default `GRAPH_DATA_CACHE_BYTES` (8 GiB) exceeds a modest container's headroom and was the proximate trigger of an 8GB-VM OOM kill | `GRAPH_DATA_CACHE_BYTES=4294967296` (4 GiB), baked as an image `ENV`; pod RAM sizing below leaves real headroom above that ceiling, not just above the cache figure |
| Upstream image ships no `curl`/`wget`/`nc` | `entrypoint.sh` and `supervisord.conf` use bash's own `/dev/tcp` for every internal wait/probe — nothing here assumes a tool the base image doesn't have |

## Local build + verification (no cloud, no registry push, no API spend)

Built with `docker buildx build -f deploy/pod/Dockerfile -t errata-pod:dryrun .` on this machine
(Apple Silicon → `linux/arm64`). **The real build for RunPod must add `--platform linux/amd64`** —
RunPod CPU pods are x86_64; an arm64 image will fail at container start on the pod, not at push.

Image size locally: **868 MB**. The base is HydraDB's own image (Ubuntu 24.04, ships the
`graph-node`/`graph-indexer` binaries and their shared libs, e.g. `libgraphblas.so.7`) plus MinIO,
`mc`, the Node 24 binary, and the `@errata/api` production tree — no dev dependencies, no
TypeScript, no source maps stripped separately (they're small; not worth a second stage).

**Why the runtime stage is `FROM` the HydraDB image and not `FROM node` with `graph-node`'s binary
copied in:** checked with `ldd` before writing the Dockerfile — `graph-node` dynamically links
`libgraphblas.so.7` (SuiteSparse GraphBLAS) and `libgomp.so.1`, neither of which is part of a bare
Debian/Ubuntu install. Lifting the binary alone risks a missing-`.so` crash that only shows up at
container start. Building `FROM` the HydraDB image guarantees every shared library it needs is
already exactly where it expects. The reverse direction — the Node 24 binary copied onto the
HydraDB (Ubuntu 24.04) base — was verified empirically instead: `ldd` on it, then run it inside the
base image; it needs nothing beyond glibc/libstdc++/libpthread, all already present.

Ran the built image locally as `errata-poddry` on an isolated Docker network and alternate host
ports (`18787→8787`, plus `17687→7687` opened *only* for this local test harness — the production
pod never maps Bolt at all). **The real dev stack (`errata-hydradb-1`, `errata-minio-1`,
`errata-minio-init-1`) was never started, stopped, or restarted** — confirmed both before and after
via `docker ps -a`.

Smoke test performed, in order:

1. **Health** — `GET /health` → `{"status":"ok"}` [200]. `GET /api/meta/health` → `readyz: true`
   before any data existed.
2. **Write** — ingested one LongMemEval history (`852ce960`, 396 turns, rule extractor — zero LLM
   calls, zero spend) through the pod's Bolt port from the host CLI: `4 claims, 1 supersession` in
   0.3s.
3. **Read** — `POST /api/ask {"question":"How much was I pre-approved for?"}` → `"$400,000"`, with
   the correct citation and the `$350,000 → $400,000` supersession chain in the response body.
4. **The one mutating route** — `POST /api/correction` (the API's only write path) appended a new
   claim (`$425,000`, superseding the prior head); a following `/api/ask` picked it up immediately.
5. **Shutdown** — `docker stop -t 60` produced, in order: `garbage collector shutdown` → `db closed`
   → `graph node stopped`, and returned in ~1.5s wall time (graceful shutdown completing fast once
   it's actually given the chance, not stalling out to the full 60s). This is the literal log line
   the gauntlet finding said never appeared before the fix.
6. **Restart** — `docker start`: data persisted (the `/api/ask` answer was unchanged), and a fresh
   `POST /api/correction` right after restart succeeded in 78ms — no `cell not owned by this node`
   lease-shadow error, confirming the clean release on shutdown actually took.
7. Torn down: `docker rm -f errata-poddry`, its network, and its scratch data directory. Only
   resources named `errata-poddry` were touched at any point.

## Deploying: build → push → create → verify

### 0. Prerequisites (once)

- A container registry to push to (e.g. `ghcr.io/<you>/errata-pod`), and a read-only pull
  credential registered with RunPod (`POST /v2/registries` or the console — record the returned
  credential id, never the token itself, anywhere durable).
- A RunPod network volume, created once: **50 GB, `STANDARD`, data center `US-TX-3`** (verified live
  via the RunPod catalog API: `US-TX-3` carries `STANDARD` network volumes and
  `GDPR`/`ISO_IEC_27001`/`SOC_2_TYPE_2`/`HIPAA` compliance flags; a network volume pins whatever pod
  attaches it to that same data center, so pick the DC before creating either). **Do not use
  `AP-IN-1` or `US-KS-2`** — both were confirmed to report `networkVolumeTypes: []`, so
  anything written there is gone on the next stop, not just the next terminate.

### 1. Build and push

```bash
echo "$REGISTRY_PAT" | docker login <registry> -u <user> --password-stdin
docker buildx build --platform linux/amd64 \
  -f deploy/pod/Dockerfile \
  -t <registry>/errata-pod:$(git rev-parse --short HEAD) \
  --push .
```

`--platform linux/amd64` is mandatory on Apple Silicon — see above.

### 2. Instance sizing

Verified live against the RunPod CPU catalog: `cpu3m` (Memory-Optimized, CPU3 generation)
is **8 GB RAM per vCPU** at **$0.055/vCPU/hr**. At 2 vCPU that's **16 GB RAM for $0.11/hr**
(≈$2.64/day). That headroom is the direct fix for the OOM-kill lesson: the image caps HydraDB's own
cache at 4 GiB, and 16 GB total leaves the rest for MinIO, the OS, `graph-node`'s non-cache memory,
and a burst ingest — not just barely more than the cache figure. Don't go below this; the smaller
`cpu3g` (4 GB/vCPU) tier is the one that produced the original OOM story.

Pod creation parameters:

```
cpu: { instanceId: "cpu3m", count: 2 }
imageName: <registry>/errata-pod:<tag>
registry: <credential id from step 0>
disk: 30                                    # container disk — erased on every stop, holds only the image+logs
ports: ["8787/http"]                        # the ONLY exposed port; never add 7687 or 9090
mounts: { network: { volumeId: <id>, mountPath: "/data" } }
dataCenterId: US-TX-3
env: see below
```

No GPU. This is a graph engine + object store + HTTP router, not a model host.

### 3. Environment

Everything in `deploy/pod/Dockerfile`'s `ENV` block is already the pod's default — do not restate
it at pod-creation time unless overriding. Set only what `deploy/pod/env.pod.example` lists:

| Var | Where it comes from |
|---|---|
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | **Required.** RunPod Secrets (`{{ RUNPOD_SECRET_<name> }}`), not plain env. `entrypoint.sh` refuses to start without them and derives `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` from them itself. |
| `ERRATA_DEMO_HISTORY` | Plain env — which ingested history `/api/*` routes default to. |
| `OPENROUTER_API_KEY` | **Required** — see *The key has to be on the pod* below. RunPod Secrets. |
| `ERRATA_BUDGET_CAP` | **Set it alongside the key.** Hard cap on cumulative USD ledger spend; default 50. Plain env. |
| `ERRATA_WRITE_KEY` | **Required.** The shared secret gating `POST /api/correction`. RunPod Secrets, and the *same value* in the Vercel project so its proxy can inject it. See *The write path* below. |
| `ERRATA_DEBUG_OK` | **Never set this on the pod.** `=1` makes `POST /api/ask` honour `"debug": true`. See *The debug trace* below. |
| `ERRATA_TAU`, `ERRATA_MATERIAL_MAX` | Optional answer-path tuning; both have working defaults. |
| `GIT_SHA`, `ERRATA_CORPUS_REVISION` | Optional; surfaced read-only by `GET /api/meta`. |

Editing env on a live pod restarts it and wipes the container disk (not the volume) — get the env
map right at creation and treat the pod as immutable afterwards; redeploy by recreating, not editing.

#### The key has to be on the pod

Earlier guidance here said to leave `OPENROUTER_API_KEY` off the pod because `/api/ask` "works
without it". It does — but *works* is carrying far too much weight in that sentence. With no key
`answerCompleter()` returns null (`apps/api/src/deps.ts`) and every ask falls back to the
deterministic fold. That is not a degraded flourish, it is a different system: **8.3 overall against
the 60.0 published in `eval/RESULTS.md`** — and it degrades *silently*, with 200s and citations and
no error anywhere. A judge opening the deployed URL while the README claims reproducibility would be
measuring the fold and attributing it to the published numbers.

So set it, behind RunPod Secrets, and set `ERRATA_BUDGET_CAP` with it. What made "leave it off"
tempting was fear of unbounded spend on an always-on box, and that fear was well founded while the
cap re-armed on every restart: `deps.ts` used to construct the client with `initialSpent: 0`, so a
restarted pod began drawing against a fresh cap no matter what the ledger already recorded. It now
seeds from `rollup(defaultLedgerDir(), cap).spent_usd` — the same on-disk ledger, and the same
rollup, that the ingest CLI seeds from and that `GET /api/meta/costs` reports. The cap is cumulative
across restarts, which is what "hard cap" was always meant to mean. The ledger lives under the API
process's `var/ledger`, so put that on the network volume if the cap should also survive a *recreate*
and not just a restart.

#### The write path

`POST /api/correction` is the only route that writes, the write is append-only by design, and there
is therefore no undo. On a public URL that needs a gate, and it has one: `apps/api/src/auth.ts`
refuses any correction not carrying `X-Errata-Write-Key` equal to `ERRATA_WRITE_KEY`.

The gate **fails open when the variable is unset, closed when it is set.** That asymmetry is
deliberate — a laptop, `vitest`, the compose stack and the eval harness all keep working untouched,
and the pod, the one place a stranger can reach the route, sets it. It also means *forgetting* to
set it leaves the write path wide open with no complaint, so treat it as required rather than
optional and verify after boot (§5).

The browser app never sees the secret: the Vercel proxy
(`apps/web/app/api/errata/[...path]/route.ts`) injects the header server-side from its own env, so
set the same value in the Vercel project too. That proxy now also requires an `Origin` header on
POSTs — browsers send one on every POST, including same-origin — because without it an
`Origin`-less caller could have used the proxy as a relay that attaches the write key on its behalf.

#### The debug trace

`POST /api/ask` accepts `"debug": true`, which attaches a diagnostic trace carrying the verbatim
evidence spans of every ranked claim plus a bounded scan of the history's own claims. That is a
transcript read-out any caller could request by setting one body field, so it is now gated on
`ERRATA_DEBUG_OK=1`, and **the pod must never set that variable**. Where it is absent `debug: true`
is silently ignored rather than rejected, so an older client that sends it keeps working.

`eval/failure_review.py` *does* depend on the trace — its `replay()` posts `"debug": True` and reads
`trace.material`, `trace.history_claims` and `trace.abstain_reason` — so **run it against a local or
dev API with `ERRATA_DEBUG_OK=1` set, never against the pod.** The scoring harness does not depend on
it: `eval/errata_eval/arms.py` sends no `debug` field at all, so a full eval run against a pod
without the variable is unaffected. Verified both directions against the local API: no
`trace` key without the variable, trace present with it.

#### Rate limiting

Every route sits behind a per-caller fixed-window cap (`apps/api/src/ratelimit.ts`): 60 requests per
minute, keyed on `X-Forwarded-For`'s leftmost entry (RunPod's proxy and Vercel's both set one) or
else the socket address, answering `429` with a `retry-after` past that. Loopback callers are exempt,
which is what stops an in-pod ingest run or a local eval sweep from capping itself. It is one Map in
the API process: nothing to deploy, nothing to configure, and nothing that survives a restart.

### 4. Start

Nothing to run by hand — the image's `ENTRYPOINT` (`deploy/pod/entrypoint.sh`) does first-boot setup
and hands off to `supervisord`, which brings up MinIO, then the bucket, then HydraDB, then the API,
in that order, automatically, on every boot.

### 5. Verify from outside, not from the dashboard

```bash
BASE=https://<podId>-8787.proxy.runpod.net
curl -sS "$BASE/health" -w ' [%{http_code}]\n'
curl -sS "$BASE/api/meta/health?history_id=<id>" -w ' [%{http_code}]\n'
curl -sS -X POST "$BASE/api/ask" -H 'content-type: application/json' \
  -d '{"question":"<a real question>","history_id":"<id>"}'
```

A real round-tripped `/api/ask`, not just the liveness ping — matches the local smoke test above.

Then verify the three hardening gates actually took, because each of them fails *silently* in the
unsafe direction if the env map was wrong:

```bash
# the write gate is CLOSED — this must be 401, not 201. A 201 means ERRATA_WRITE_KEY is unset
# on the pod and you have just appended a real claim to the demo history (there is no undo).
curl -sS -o /dev/null -w 'no key -> %{http_code}\n' -X POST "$BASE/api/correction" \
  -H 'content-type: application/json' \
  -d '{"subject":"probe","attribute":"probe","value":"probe"}'          # expect 401

# the answer path is the PUBLISHED one, not the fold: expect "errata-graph-synthesis@2".
curl -sS "$BASE/api/meta" | grep -o '"answer_mechanism":"[^"]*"'

# the debug trace is OFF: the response must carry no `trace` key.
curl -sS -X POST "$BASE/api/ask" -H 'content-type: application/json' \
  -d '{"question":"<a real question>","history_id":"<id>","debug":true}' | grep -c '"trace"'   # expect 0
```

The correction probe above is deliberately written to be refused. Do **not** re-run it with the real
key "just to check the happy path": it would append a junk claim to the demo history, and the
append-only invariant means the only way to walk that back is another correction on top of it.

### 6. Loading data onto the pod

The pod image ships the API server only, not the ingest CLI or the 277 MB LongMemEval corpus —
ingestion is a separate, occasional operation, not something the always-on server needs bundled.
Bolt is intentionally never exposed externally (topology above), so run the ingest CLI from a
machine that can reach it directly: SSH/exec into the pod (RunPod's own pod terminal) and run it
from there against `bolt://127.0.0.1:7687`, the same way this repo's `packages/ingest` CLI already
runs locally against the compose stack. Point `--lexicon-dir` at `/data/lexicon` so the lexicon
artifact survives a stop (the image already sets `ERRATA_LEXICON_DIR=/data/lexicon` for the API
side to read it back from).

### 7. Redeploy

New image tag, recreate the pod. The network volume survives (`/data` is untouched); the pod itself
is cattle — never patch a live one.

## Unresolved — could bite during the real deploy

- **Outer container stop-timeout.** `supervisord.conf` waits up to 58s for `graph-node` to flush
  before it escalates to SIGKILL — verified locally that a real shutdown finishes in ~1.5s once
  given the chance. What was *not* verified is whether RunPod's own stop/restart path grants
  the container that long before it forces a kill itself; there's no cloud pod to test this against
  without spending money. Confirm this first, ideally by an actual `docker stop`
  timing test against the running pod before it holds real data.
- **`cpu3m` stock in `US-TX-3`.** The catalog call confirmed the flavor and rate exist;
  it does not confirm current availability. Check the console's deploy form before committing to a
  data center.
- **Registry credential flow.** Not exercised (would require creating a real registry
  credential against a live account) — the `POST /v2/registries` step in §0 is written from the API
  shape, not from having run it.
- **`errata-ingest` isn't in the pod image.** §6 above documents SSH-based ingestion as the
  intended path, but it hasn't been run against an actual RunPod pod terminal — only against the
  local dry-run container over a host-mapped port, which is a reasonable stand-in but not identical.
