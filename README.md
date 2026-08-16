# Errata

**Memory that keeps its corrections.**

An agent-memory layer built on [HydraDB](https://github.com/hydra-db/hydradb) for Hack Hydra
(Track 3 — Memory & Context Retrieval). All work in this repository starts on or after 2026-08-12,
per hackathon rules.

Every shipped memory layer is a write-once fact store. Errata treats a conversation as a stream of
**revisions to a belief state**: claims are appended, never overwritten; each edge carries
event-time, ingest-time, a session-and-turn citation, and an `EXTRACTED`/`INFERRED` provenance tag;
a contradiction becomes a first-class `SUPERSEDES`/`CONTRADICTS` revision edge. Ask *"what is the
value now?"* and you get the current belief with its citation; ask *"what did we believe on Aug 3,
and when did it change?"* and you get the history; ask something the transcript never said and you
get a calibrated **abstention** with the nearest misses. Nothing is ever mutated or deleted.

## Status

**Backend and evaluation harness complete.** Frontend, deployment, and funded LLM runs are pending
(the later days of the plan). Concretely:

- **Write path** — deterministic ingest (sessions/turns/speakers + `STATED_IN`, then rule-based claim
  extraction + temporal conflict resolution → `SUPERSEDES`/`CONTRADICTS`/`SUPPORTS` revision edges),
  running on the real 500-history LongMemEval corpus in HydraDB + MinIO.
- **Read surface** — `GET /api/belief` (current + as-of), `GET /api/diff` (revision chain with
  `algo.SPpaths` cross-validation), `POST /api/ask` (cited answer or calibrated abstention),
  `GET /api/meta{,/health,/costs}`. Every answer carries a `{session_id, turn_index, span}` citation.
- **Eval harness** (`eval/`, Python/uv) — dataset invariants (the 30-abstention rule), a `/api/meta`
  parity gate, deterministic sampler + judge-control set, metrics + the one results table. Its parity
  gate passes against the live API.
- **Credit-gated, wired but not run** — the LLM extractor and conflict judge (behind the same
  interfaces as the deterministic path) and the eval's full-context / naive-topk baselines. They run
  the moment an OpenRouter key is funded; the append-only model makes a later LLM pass safe (a new
  `run_id`, nothing mutated).

## Quickstart (from a clean clone)

```bash
pnpm install && pnpm typecheck            # install (exact pins) + build every workspace

# fetch the public dataset (MIT, ~277 MB) into the gitignored data-raw/
mkdir -p data-raw && curl -L -o data-raw/longmemeval_s_cleaned.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json

pnpm stack:up                             # HydraDB + MinIO on 127.0.0.1 (healthy in ~10s)

node packages/ingest/dist/cli.js 852ce960                  # ingest the demo history (deterministic claims)
# optional — the whole 500-history corpus, structural pass only (zero LLM, ~5 min):
#   node packages/ingest/dist/cli.js --all --structural-only

ERRATA_DEMO_HISTORY=852ce960 node apps/api/dist/index.js &  # API on 127.0.0.1:8787

# the demo: a pre-approval amount that was revised $350,000 → $400,000
curl -s 'http://127.0.0.1:8787/api/belief?subject=the%20user&attribute=mortgage_preapproval_amount'
curl -s -X POST http://127.0.0.1:8787/api/ask -H 'content-type: application/json' \
  -d '{"question":"What was the amount I was pre-approved for from Wells Fargo?"}'
```

`pnpm verify` runs the four gates (lint · typecheck · test · — plus `pnpm audit` and `pnpm licenses`
in CI). `uv run --directory eval pytest` runs the harness tests. `docs/gauntlets.md` records the
substrate limits we hit and the workaround next to each.

## Layout

`apps/web` (Next.js 16 → Vercel) · `apps/api` (Hono → pod) · `packages/core` (pure belief-revision
logic, vitest) · `packages/graph` (Bolt client + hand-written Cypher + blake2b ids) · `packages/llm`
(OpenRouter client + cost ledger) · `packages/ingest` (pipeline CLI) · `eval/` (Python 3.13, uv).

## What this project loses without HydraDB

The storage model. Supersession **is** append-only timestamped edges — HydraDB's own model
(*"updates commit new timestamped edges instead of overwriting"*). On a mutable store, the revision
history this product sells would have to be faked; here it is the substrate doing exactly what it was
built to do. Time-travel and revision-diff are a few lines of hand-written Cypher and impossible in a
vector store.

## Dependencies & supply chain

Every dependency is pinned to an exact version (no `^`/`~`), the lockfile is committed, and
`allowBuilds` is empty — **no dependency may run an install script**. The JS tree is 18 direct
packages, all MIT / Apache-2.0 / BSD / ISC; a CI license gate fails on strong copyleft (GPL/AGPL).
The only hashing dependency is **`@noble/hashes` (MIT)** — BLAKE2b for the 53-bit vertex ids; it is
audited, script-free, and chosen so the id math is byte-identical to the Python (`hashlib.blake2b`)
side, pinned by `packages/graph/fixtures/id-vectors.json` in both test suites.
