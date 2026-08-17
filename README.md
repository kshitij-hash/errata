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

## Status & results

**Complete: write path, read surface, web app, and a judged three-arm evaluation.** On a
150-question LongMemEval comparison (3 seeds, judge validated at FAR 8.3%), **Errata leads
overall — 53.3 vs 47.5 (full-context) vs 45.8 (naive top-k RAG)** with **knowledge-update at
100.0** and multi-session 61.3, at **1/52nd the context tokens, ~1/500th the $/question and 31×
lower p50 latency** than reading the full history — with a citation on every answer and abstention
recall 0.93. Full table, caption, and the honest gaps: [`eval/RESULTS.md`](eval/RESULTS.md);
failure analysis in [`eval/out/failure-taxonomy.md`](eval/out/failure-taxonomy.md).

- **Write path** — LLM claim extraction (structured-output, per-claim salvage) + an LLM conflict
  judge → `SUPERSEDES`/`CONTRADICTS`/`SUPPORTS` revision edges, run over the real LongMemEval
  corpus in HydraDB + MinIO (all 500 histories structurally; the comparison-150 with full claims).
- **Read surface** — `GET /api/belief` (current + as-of), `GET /api/diff` (revision chain with
  `algo.SPpaths` cross-validation), `POST /api/ask` (graph-retrieved material composed by the
  shared answer model, or a calibrated abstention), `GET /api/meta{,/health,/costs}`. Every answer
  carries a `{session_id, turn_index, span}` citation.
- **Eval harness** (`eval/`, Python/uv) — dataset invariants, a `/api/meta` parity gate asserting
  the deployed prompt/model before any spend, deterministic sampling, a validated judge (published
  control sets + FAR/FRR), cost estimator with a hard cap, and the one results table.
- **Substrate findings** — every HydraDB limit we hit, measured and worked around, is in
  [`docs/gauntlets.md`](docs/gauntlets.md) (and on the demo's `/limits` page).

## The web app

`apps/web` (Next.js 16, App Router, React 19, Tailwind v4) serves five routes: **Ask** — the answer
with its struck predecessors, a live transcript column with a highlighter sweep on the cited span, a
per-answer economics line and the exact Cypher behind the answer; **Timeline** — the revision chain
replaying over event time, with a Constellation view of the same claims; **Compare** — vector
similarity against the belief graph; **Exhibit**; and **Limits**. Every number on screen comes from
the API at request time; nothing about an answer is hard-coded.

Three deliberate properties:

- **No UI, motion, icon or graph library.** The scrubber is `<input type=range>`, the disclosure is
  `<details>`, the graph is ~60 lines of SVG physics, the icons are Unicode glyphs. `apps/web` has
  **8 direct dependencies** (next, react, react-dom, tailwindcss, @tailwindcss/postcss, postcss and
  two `@types`), which is the whole reason the supply-chain claim above survives contact with a UI.
- **Nothing leaves the origin.** Fonts (Fraunces, Inter, IBM Plex Mono — all OFL 1.1) are vendored as
  woff2 and loaded with `next/font/local`; the API is reached through an origin-only route-handler
  proxy; the CSP says `connect-src 'self'` and `font-src 'self'`, so the promise is enforced rather
  than asserted.
- **Light only, on purpose.** `color-scheme: only light` plus a matching `theme-color`. The design is
  a print metaphor — proof marks, hairlines, struck type — and dark mode is a documented **non-goal**,
  not an omission.

Run it against a local API:

```bash
ERRATA_API_URL=http://127.0.0.1:8787 pnpm dev:web     # http://localhost:3000
```

## Quickstart (from a clean clone)

```bash
pnpm install && pnpm typecheck            # install (exact pins) + build every workspace

# fetch the public dataset (MIT, ~277 MB) into the gitignored data-raw/
mkdir -p data-raw && curl -L -o data-raw/longmemeval_s_cleaned.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json

pnpm stack:up                             # HydraDB + MinIO on 127.0.0.1 (healthy in ~10s)

# ingest the demo history into its own history-id namespace. Two passes: the LLM extractor for
# breadth, then the rule extractor for the two mortgage facts it nails. Both land on the SAME
# claim vertices where they agree — value normalization is version-pinned into the claim key.
node packages/ingest/dist/cli.js 852ce960 --extractor llm --judge --history-suffix -clean
node packages/ingest/dist/cli.js 852ce960 --extractor rule --history-suffix -clean
# optional — the whole 500-history corpus, structural pass only (zero LLM, ~5 min):
#   node packages/ingest/dist/cli.js --all --structural-only

ERRATA_DEMO_HISTORY=852ce960-clean node apps/api/dist/index.js &  # API on 127.0.0.1:8787

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
