# Pod deployment — runbook

Everything here is standalone: it does not reference any external planning document, and nothing
in this tree needs anything outside this repo to be actioned. Written the night before deploy day
so tomorrow is push-and-start, not figure-it-out.

## What ships

```
deploy/
├── README.md                  this file
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
| The upstream image's default stop behaviour SIGKILLs before the writer lease is released | `deploy/pod/supervisord.conf`: `[program:hydradb]` sets `stopsignal=TERM stopwaitsecs=58`, so supervisord itself waits up to 58s before escalating. Verified locally tonight — see below. |
| Writer-lease churn on write-idle re-opens SlateDB and leaks ~200MB per re-open, ratcheting RSS to OOM | `GRAPH_WRITER_LEASE_MS=120000`, baked as an image `ENV` — outlives the write gaps between ingest bursts |
| `CLOUD_PROVIDER=local` silently drops writes under load | `entrypoint.sh` refuses to start unless `CLOUD_PROVIDER=aws`; the image also bakes `CLOUD_PROVIDER=aws` as the default so it takes an explicit override to break |
| The default `GRAPH_DATA_CACHE_BYTES` (8 GiB) exceeds a modest container's headroom and was the proximate trigger of an 8GB-VM OOM kill | `GRAPH_DATA_CACHE_BYTES=4294967296` (4 GiB), baked as an image `ENV`; pod RAM sizing below leaves real headroom above that ceiling, not just above the cache figure |
| Upstream image ships no `curl`/`wget`/`nc` | `entrypoint.sh` and `supervisord.conf` use bash's own `/dev/tcp` for every internal wait/probe — nothing here assumes a tool the base image doesn't have |

## Local build + verification (tonight — no cloud, no registry push, no API spend)

Built with `docker buildx build -f deploy/pod/Dockerfile -t errata-pod:dryrun .` on this machine
(Apple Silicon → `linux/arm64`). **The real build tomorrow must add `--platform linux/amd64`** —
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

## Tomorrow morning: build → push → create → verify

### 0. Prerequisites (once)

- A container registry to push to (e.g. `ghcr.io/<you>/errata-pod`), and a read-only pull
  credential registered with RunPod (`POST /v2/registries` or the console — record the returned
  credential id, never the token itself, anywhere durable).
- A RunPod network volume, created once: **50 GB, `STANDARD`, data center `US-TX-3`** (verified live
  tonight via the RunPod catalog API: `US-TX-3` carries `STANDARD` network volumes and
  `GDPR`/`ISO_IEC_27001`/`SOC_2_TYPE_2`/`HIPAA` compliance flags; a network volume pins whatever pod
  attaches it to that same data center, so pick the DC before creating either). **Do not use
  `AP-IN-1` or `US-KS-2`** — both were confirmed tonight to report `networkVolumeTypes: []`, so
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

Verified live against the RunPod CPU catalog tonight: `cpu3m` (Memory-Optimized, CPU3 generation)
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
without the variable is unaffected. Verified both directions against the local API tonight: no
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
  given the chance. What was *not* verified tonight is whether RunPod's own stop/restart path grants
  the container that long before it forces a kill itself; there's no cloud pod to test this against
  without spending money. Confirm this first thing tomorrow, ideally by an actual `docker stop`
  timing test against the running pod before it holds real data.
- **`cpu3m` stock in `US-TX-3`.** The catalog call tonight confirmed the flavor and rate exist;
  it does not confirm current availability. Check the console's deploy form before committing to a
  data center.
- **Registry credential flow.** Not exercised tonight (would require creating a real registry
  credential against a live account) — the `POST /v2/registries` step in §0 is written from the API
  shape, not from having run it.
- **`errata-ingest` isn't in the pod image.** §6 above documents SSH-based ingestion as the
  intended path, but it hasn't been run against an actual RunPod pod terminal — only against the
  local dry-run container over a host-mapped port, which is a reasonable stand-in but not identical.
