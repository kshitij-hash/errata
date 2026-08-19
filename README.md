# Errata

**Memory that keeps its corrections.**

Errata is an agent-memory layer on [HydraDB](https://github.com/hydra-db/hydradb). A conversation is
ingested as an append-only, bitemporal graph of claims, and a contradiction lands as a new claim
plus a `SUPERSEDES` edge rather than an update, so the correction and the thing it corrected both
stay queryable. Ask what is true now and you get the current belief with a session-and-turn
citation. Ask what was believed on a date and you get the revision chain. Ask something the
transcript never said and you get an abstention with the nearest misses, scored as an answer.

It ships as three surfaces on one API: a **web app** — ask, timeline, compare, and an auditable
[`/results`](#the-web-app) page where every published eval number opens the raw judged rows behind
it; an **MCP server** ([`packages/mcp`](packages/mcp)) that lets any MCP-capable agent mount the
memory — ask it, correct it, and read the revision history, live-captured in
[`docs/mcp-demo.md`](docs/mcp-demo.md); and the HTTP API itself.

Memory layers routinely claim contradiction handling. This one measured it: on LongMemEval,
against a full-context and a naive-RAG baseline, with a judge whose false-accept rate was measured
before any result was believed. The losing categories are printed with the price of fixing them,
and the experiments that failed are published beside the ones that shipped.

**Live: [errata-memory.vercel.app](https://errata-memory.vercel.app)** — ask it, replay the
timeline, and open every published number on
[/results](https://errata-memory.vercel.app/results). The API behind it:
[errata-production-e59c.up.railway.app](https://errata-production-e59c.up.railway.app).

Built for Hack Hydra (Track 3 — Memory & Context Retrieval). All participant-authored work in this
repository starts on or after 2026-08-12, per the hackathon rules.

## Measured results

<!--
  ══ NUMBERS BLOCK — the only place in this README that carries eval constants. ══
  Source of truth: eval/RESULTS.md. Never retype a number from it anywhere else in this file.
  Runs of record: rerunJ-arith (Errata) · rerunB-nothink (full-context) · rerunC-nothink (naive top-k).
  Prior Errata runs: rerunF-wave, rerunD-g5. τ sweep: rerunJ-arith. Errata latency and $/Q are from
  rerunF-wave, the last cold-cache run. Judge validation: eval/judge-validation.md (committed
  120-item control set). Statistics: eval/stats.py → eval/out/stats.md.
  If a later eval wave changes the table, refresh THIS BLOCK ONLY and nothing else moves.
-->

**Errata scores 60.0 overall against 47.5 for reading the full history and 45.8 for naive top-k
RAG — at 1/43rd the context tokens, roughly 1/430th the $/question, and 31× lower p50 latency,
with a citation on every answer.** All three arms answer with the same small model
(`qwen/qwen3.7-flash`) and the same prompt, sha-verified before any spend, so this table measures
the memory layer rather than the reader. Its numbers are deliberately not comparable to
leaderboard scores produced with frontier readers, including HydraDB's own published LongMemEval
results. On abstention, Errata has higher recall than full-context (0.93 vs 0.80) and lower
precision (0.49 vs 0.58): it catches more truly-unanswerable questions and also over-refuses more
often, and both halves are scored and printed.

| Arm | Overall | Info. extraction | Multi-session | Temporal | Knowledge update | Abstention P / R | Ctx tok/Q | $/Q | p50 / p95 (s) |
|---|---|---|---|---|---|---|---|---|---|
| **Errata** | **60.0 ± 0.0** | 44.7 ± 0.0 | **67.7 ± 0.0** | **51.5 ± 0.0** | **94.4 ± 0.0** | 0.49 / 0.93 | **2,532** | **$0.000026** | **0.26 / 1.28** |
| Full-context baseline | 47.5 ± 0.8 | **80.7 ± 1.5** | 35.5 ± 3.2 | 13.1 ± 1.7 | 61.1 ± 0.0 | 0.58 / 0.80 | 109,943 | $0.0110 | 8.00 / 8.68 |
| Naive top-k RAG (k=10) | 45.8 ± 0.0 | 63.2 ± 0.0 | 29.0 ± 0.0 | 21.2 ± 0.0 | 83.3 ± 0.0 | 0.41 / 0.98 | 4,665 | $0.0005 | 0.86 / 1.34 |

150 LongMemEval questions (`xiaowu0162/longmemeval-cleaned`, revision `98d7416c…`, sha256
`d6f21ea9…`), a seeded stratified subsample with **all 30 abstention questions included**; 3 seeds
(11/22/33) at temperature 0. The four ability columns score the 120 non-abstention questions;
abstention is scored deterministically by exact match and never reaches the judge. Counting all
450 rows including abstention, the same runs read Errata 66.7, naive 56.2, full-context 54.0.
The `±` column is per-seed sd, and it is not symmetric evidence: the baselines' spread is provider
nondeterminism across three real draws, while Errata's ±0.0 is structural — its one LLM call
per question is cached without the seed, so seeds 22 and 33 replay seed 11 byte-for-byte. Errata's
`$/Q` and latency are measured on `rerunF-wave`, the last cold-cache run; the current run replayed
447 of 450 answers from cache, which would flatter both columns.

**The ordering is defended; the point estimates are not oversold.** On paired exact McNemar
(questions as the pairing unit, seeds majority-collapsed), Errata beats full-context 29 wins / 15
losses (p = 0.049) and naive 31/14 (p = 0.016) on the overall-120, and 33/15 (p = 0.013) / 31/15
(p = 0.026) on the all-450 — significant at 0.05 under every seed-collapse rule tested, with
the rule-sensitivity grid published. The paired-bootstrap 95% CI on Errata's 60.0 is [51.7, 69.2]
(percentile; basic [50.8, 68.3]) — wide, because n = 120 — but every paired *gap* interval
excludes zero. Correcting every arm for the judge's own measured false-accept rate widens
Errata's lead (12.5 → 14.5 points; 17.5 at the judge's worst-case envelope), because the arm that
abstains more gives a fallible judge less to inflate. Recompute all of it:
[`eval/stats.py`](eval/stats.py) → `eval/out/stats.md`.

**Honest gap, kept next to the headline.** Single-fact **information extraction is 44.7 against
full-context's 80.7** — the one column Errata loses, and it loses it badly. Cut by the corpus's own
question types, the entire remaining deficit is 22 of 150 questions:
`single-session-assistant` 7.1% (against 92.9% for both baselines) and
`single-session-preference` 0.0% (against 20.8% for full-context). Both are write-path gaps —
the fact is not in the graph to retrieve — and the first one is a priced decision rather than a
modelling result: lifting the extraction cap that drops long enumerated assistant answers was
projected at $20.72 to re-extract the 150 histories against the $4.19 the shipped
configuration cost. A $0 deterministic recall pass aimed at the same gap was built, applied,
measured at 62.7 (below the then-shipped 65.3), reverted, and the revert verified
answer-for-answer. Across the two published waves, knowledge-update regressed 100.0 → 94.4 and
context cost rose 21% (2,095 → 2,532 tokens/question); three questions regressed against eleven
improved (nine in the temporal wave, two in the arithmetic wave), each one traced. And because the
same 150 questions were measured repeatedly while the answer path improved,
[`eval/RESULTS.md`](eval/RESULTS.md) discloses which gains are question-agnostic and which are
in-sample patches, with the significance tests, rather than leaving that to be discovered.

**The judge was validated before the table was believed.** False-accept rate 8.3% (5/60) on
committed perturbed negatives against a ≤10% gate — 15.0% before a disclosed control-set
revision that fixed 7 defective controls with the judge itself untouched; false-reject 0.0%
(0/60) on paraphrased golds. Per family: superseded-value 0.0% (0/12), the category this
table's thesis rests on, and **attribution-flip 25.0% (3/12), which FAILS its own gate and is
published as a failure**, worst-case 75% once the six truncated verdicts are counted as accepts.
The calibration caveats (the controls are easier than in-run errors; the superseded-value rubric
is prompted, not emergent) are in [`eval/judge-validation.md`](eval/judge-validation.md).

**What produces an abstention — corrected.** An earlier version of this README said abstention was
"gated at E ≥ τ." Our own pre-submission audit found that describes a code path that did not
produce these abstentions, and the correction is published rather than reworded: the evidence
score E is computed and returned on every row, but in the shipped synthesis path the abstention
decision is the answer model returning `INSUFFICIENT_INFORMATION` from its material; the
deterministic τ gate governs the keyless fallback and would bind on exactly one answered question
here. τ was never fitted — every abstention-positive question the corpus owns is inside this test
set, so no honest held-out slice exists — and the committed sweep shows what a τ veto *would*
cost: overall 66.7 either way. The full mechanism account: `eval/RESULTS.md`.

Full tables, before/after, the failure taxonomy, and the rejected experiments:
[`eval/RESULTS.md`](eval/RESULTS.md) · [`eval/judge-validation.md`](eval/judge-validation.md) ·
[`eval/out/failure-taxonomy.md`](eval/out/failure-taxonomy.md).

<!-- ══ END NUMBERS BLOCK ══ -->

## How it works

Seven invariants, each one enforced somewhere you can open:

- **Claims are append-only.** Nothing is ever mutated or deleted — any mutation or deletion path is
  a bug, and there is no delete API to call. Re-ingesting a history is idempotent down to identical
  vertex ids (`packages/ingest` regression suite).
- **Bitemporal by construction.** Every claim carries `event_time` (when it was true) and
  `ingest_time` (when we learned it), plus a `{session_id, turn_index, span}` citation, a
  confidence, and an `EXTRACTED`/`INFERRED` provenance tag; revision edges carry `ingest_time`
  (their `event_time` is the unknown sentinel), and the as-of fold filters on exactly that.
- **Revision edges *are* the history.** A contradiction appends a new claim and a
  `SUPERSEDES`/`CONTRADICTS` edge from it to the claim it displaces (agreement appends `SUPPORTS`).
  The chain is the audit trail; there is no separate log to fall out of sync.
- **Beliefs are derived, never stored.** The belief for a `(subject, attribute)` pair is folded
  deterministically in app code from the claims and their revision edges (`packages/core`). *As-of*
  is the same fold behind an edge-time filter, which is why time travel is a query and not a feature.
- **Abstention is first-class and scored.** "Not in the history" comes back with nearest-miss
  citations and is scored in the results table like any other answer. Every ask computes and
  returns an evidence score `E` (five a-priori weights); the shipped abstention decision itself is
  made by the answer model from its material — see the corrected mechanism note above.
- **No vector store in the answer path.** Retrieval is entity-anchored graph traversal ranked by
  span-aware IDF coverage over attribute, value and the transcript's own evidence span. The only
  embeddings in this repo are the naive baseline arm being measured, and one committed fixture that
  demonstrates what a vector store retrieves on the demo history.
- **Hand-written Cypher against HydraDB's deliberate OpenCypher subset.** No ORM, no query-generating
  framework: the subset rejects undirected patterns, `IN`, `CONTAINS`, `IS NULL`, `RETURN *`,
  `min()`/`max()`, filtering `WITH` and unbounded `*` at parse time. Upsert is `MERGE {id}` then a
  single `SET`; writes go in ≤1024-row `UNWIND` batches over Bolt; vertex ids are 53-bit blake2b
  hashes minted in exactly one file. The answer path's reads are id-anchored, never label scans.

Read surface: `GET /api/belief` (current + as-of) · `GET /api/diff` (revision chain, cross-checked
against `algo.SPpaths`) · `GET /api/turns` · `POST /api/ask` (graph-retrieved material composed by
the shared answer model, or an abstention) · `GET /api/meta{,/health,/costs}`. One write:
`POST /api/correction` — it appends a claim and a `SUPERSEDES` edge, because appending is the only
kind of write this system has. Every answer carries its citation; an uncited answer is a bug.

### What this project loses without HydraDB

The storage model. Supersession **is** append-only timestamped edges — HydraDB's own design
(*"updates commit new timestamped edges instead of overwriting"*). On a mutable store the revision
history this product sells would have to be faked; here it is the substrate doing exactly what it
was built to do, and time-travel and revision-diff are a few lines of hand-written Cypher rather
than an impossibility in a vector index. Everything we hit on the way — the writer-lease memory
ratchet, the label-scan admission-control ceiling, the strict `MERGE`/`SET` recognizer form, the
50× cost of anchoring a traversal from the wrong end — is measured and written down with its
workaround in [`docs/gauntlets.md`](docs/gauntlets.md), and rendered on the demo's `/limits` page.

## The web app

`apps/web` (Next.js 16, App Router, React 19, Tailwind v4). The demo surfaces:
**Ask** — the answer with its struck predecessors, a live transcript column with a highlighter
sweep on the cited span, a per-answer economics line and the exact Cypher behind the answer;
**Timeline** — the revision chain replaying over event time, with a Constellation view of the same
claims; **Compare** — vector similarity against the belief graph; **Exhibit**; **Field notes** — the
twelve HydraDB operating limits this project hit, measured, with workarounds. The audit surfaces:
[`/results`](apps/web) — the published table where every cell, including the losing ones and the
two rejected experiments, opens the raw judged rows behind it, recomputed at build time from a
committed per-row bundle; and `/results/judge` — all 120 judge-validation controls, the failing
family included. The demo surfaces render from the API at request time; the `/results` pages render
a committed, frozen bundle of judged rows — a fixed eval artifact rather than a live query.

## The MCP server

[`packages/mcp`](packages/mcp) mounts the memory in any MCP-capable agent, over stdio, against the
same HTTP API: `memory_ask` (a cited answer, or a structured abstention with nearest misses —
never an error), `memory_correct` (append a correction; returns the updated revision chain),
`memory_history` (every claim that ever held for a subject-attribute, with what displaced it and
why), `memory_remember`. [`docs/mcp-demo.md`](docs/mcp-demo.md) is a captured live transcript: an
agent asks and gets a cited answer, is corrected mid-conversation, writes the correction, and
re-asks — with the `SUPERSEDES` chain, including the struck values, visible at every step. The
mounting config is one JSON block in [`packages/mcp/README.md`](packages/mcp/README.md).

## Reproduce it

Prerequisites: Node ≥ 24.12 (`.nvmrc` pins 24.19.0), pnpm 11.22.0, Docker, and `uv` for the eval
harness. `pnpm stack:up` generates the HydraDB auth token into the gitignored `.data/` and writes
your uid/gid, so the local defaults need no configuration: Bolt at `bolt://127.0.0.1:7687`, API on
`127.0.0.1:8787`, τ 0.35, material window 30 claims. The one variable you must supply yourself is
`OPENROUTER_API_KEY` (every LLM call goes through OpenRouter and is ledgered against
`ERRATA_BUDGET_CAP`) — export it, or put it in the gitignored `.env.local` the stack reads. Full
list with comments: [`.env.example`](.env.example). Everything below except the funded ingest runs
without a key.

```bash
pnpm install && pnpm typecheck            # exact pins, no install scripts; builds every workspace

# the public dataset (MIT, ~277 MB) into the gitignored data-raw/, pinned to the revision the
# eval harness verifies by sha256
mkdir -p data-raw && curl -L -o data-raw/longmemeval_s_cleaned.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json

pnpm stack:up                             # HydraDB + MinIO on 127.0.0.1 (healthy in ~10s)

# ingest the demo history into its own history-id namespace. Two passes: the LLM extractor for
# breadth, then the rule extractor for the two mortgage facts it nails. Both land on the SAME
# claim vertices where they agree — value normalization is version-pinned into the claim key.
node packages/ingest/dist/cli.js 852ce960 --extractor llm --judge --history-suffix -clean
node packages/ingest/dist/cli.js 852ce960 --extractor rule --history-suffix -clean
# optional — the whole 500-history corpus, structural pass only (zero LLM, ~6.5 min):
#   node packages/ingest/dist/cli.js --all --structural-only

ERRATA_DEMO_HISTORY=852ce960-clean node apps/api/dist/index.js &   # API on 127.0.0.1:8787

# the demo: a pre-approval amount that was revised $350,000 → $400,000. (The deployed demo carries
# one more hop — a $425,000 correction appended live through POST /api/correction.)
curl -s 'http://127.0.0.1:8787/api/belief?subject=the%20user&attribute=mortgage_preapproval_amount'
curl -s -X POST http://127.0.0.1:8787/api/ask -H 'content-type: application/json' \
  -d '{"question":"What was the amount I was pre-approved for from Wells Fargo?"}'

ERRATA_API_URL=http://127.0.0.1:8787 pnpm dev:web                  # the app on localhost:3000
```

`pnpm verify` runs the three local gates (lint · typecheck · test); CI adds `pnpm audit`, the
license gate, and the eval harness's own tests. The eval harness is standalone and talks to Errata
only over HTTP:

```bash
cd eval && uv sync && uv run pytest        # harness tests, offline, no spend
uv run errata-eval sample --n 150 --print-ids   # the seeded comparison set, from the config alone
uv run errata-eval parity                  # /api/meta prompt+model gate, before any spend
```

The published table is re-derivable **without any gitignored artifact**: the committed per-row
bundle (`apps/web/data/results.json`, 450 judged rows per arm) recomputes every cell — the
`/results` page and `eval/stats.py` both do exactly that — and the entire scored 120-item judge
control set behind the FAR/FRR numbers is committed beside it. The exact command line for each
generated artifact is recorded in [`eval/RESULTS.md`](eval/RESULTS.md).

## Eval integrity

The harness (`eval/`, Python 3.13 + uv) is **not** a workspace member and never imports the TypeScript,
never opens Bolt, never reads HydraDB — it talks to `POST /api/ask` and `GET /api/meta` over HTTP, so
anyone with the deployed URL (and the funded key it requires) reproduces the numbers. What that buys:

- **A parity gate before spend.** Every run asserts the deployed model and answer-prompt sha against
  the config, so an arm cannot be compared against a different prompt by accident.
- **A validated judge, generated separately from how it is measured.** The 120 controls are committed
  artifacts; `judge-validate` never builds a control, so the same judge is always scored against the
  same set and a re-run replays from cache at $0. It exits non-zero on a failed gate.
- **Both control sets published side by side**, with the change log naming every control that moved
  and why — the revision was made by a *predicate over the gold*, never by a list of question ids,
  because selecting controls by the verdict they received is how a control set gets quietly tuned.
- **Abstention scored deterministically**, never by the judge, so the abstention numbers cannot
  inherit the judge's error rate.
- **A cost estimator with a hard cap** that runs first in every real run and refuses to start if the
  projection plus what has already been spent would breach it.
- **The failures are in the record**: two experiments judged in full and rejected, two more stopped
  before judging spend, every revert verified answer-for-answer, and the in-sample exposure of
  iterating on a fixed test set stated in `eval/RESULTS.md` instead of waiting to be found.

## Known limitations

- `single-session-assistant` and `single-session-preference` are where the arm loses; see the
  honest-gap paragraph above. Both are extraction-scope decisions, one of them explicitly bought at
  a price and disclosed rather than described as a model limitation.
- The judge's weak family is wrong-speaker attribution, published as a failing gate row.
- The full-context baseline runs on the 150-question subsample, not all 500, for cost reasons — and
  the answer path was iterated against that same 150; the gains that survive that caveat and the
  ones that may not are separated explicitly in `eval/RESULTS.md`.
- Bulk ingest is **single-writer** with a memory guard sized to the box — parallel writers ratchet
  the node's RSS; the finding and the operating rule are in `docs/gauntlets.md`.

## Layout, dependencies, attribution

`apps/web` (Next.js 16 → Vercel) · `apps/api` (Hono → pod) · `packages/core` (pure belief-revision
logic, vitest) · `packages/graph` (Bolt client + hand-written Cypher + blake2b ids) · `packages/llm`
(OpenRouter client + cost ledger) · `packages/ingest` (pipeline CLI) · `packages/mcp` (the MCP
memory server) · `eval/` (Python 3.13, uv, standalone).

Every dependency is pinned to an exact version (no `^`/`~` — CI greps for them and fails), the
lockfile is committed, and `allowBuilds` is empty: **no dependency may run an install script.** The
JS tree is deliberately small; a CI license gate fails **closed** on strong copyleft (GPL/AGPL) and
on a license report it cannot parse, and the actual production license set — MIT / Apache-2.0 /
BSD / ISC, plus reviewed single-package exceptions (MPL-2.0, LGPL-3.0-or-later dynamically linked,
CC-BY-4.0 data, 0BSD) — is enumerated explicitly in [`scripts/license-gate.mjs`](scripts/license-gate.mjs).
The only hashing dependency is **`@noble/hashes` (MIT)** — BLAKE2b for the 53-bit vertex ids,
chosen so the id math is byte-identical to the Python (`hashlib.blake2b`) side and pinned by
`packages/graph/fixtures/id-vectors.json` in both test suites.

Third-party components: **HydraDB** (consumed unmodified as a server over Bolt), **MinIO** (local
object store), **Hono**, **Next.js / React / Tailwind**, **neo4j-driver-lite** (Bolt wire protocol),
**OpenRouter** (all LLM calls, ledgered), and **`BAAI/bge-small-en-v1.5`** (the naive baseline arm
only). Dataset:
**`xiaowu0162/longmemeval-cleaned`**, pinned by revision and sha256 in `eval/eval.toml` and verified
by the harness; no private or self-collected data is used anywhere in this project.

## License

[Apache-2.0](LICENSE).
