# Errata

**Memory that keeps its corrections.**

Errata is an agent-memory layer on [HydraDB](https://github.com/hydra-db/hydradb): a conversation is
ingested as an append-only, bitemporal graph of **claims**, and a contradiction is never an update —
it is a new claim plus a `SUPERSEDES` edge, so the correction *and* the thing it corrected are both
still queryable. Ask what is true now and you get the current belief with a session-and-turn
citation; ask what was believed on a date and you get the revision chain; ask something the
transcript never said and you get a calibrated **abstention** with the nearest misses.

Every memory layer says it handles contradictions. **This one publishes what that scores** — on
LongMemEval, against a full-context and a naive-RAG baseline, with a judge whose false-accept rate
was measured before any of the results were believed, the losing categories printed with the price
of fixing them, and abstention scored as a first-class answer instead of quietly dropped.

Built for Hack Hydra (Track 3 — Memory & Context Retrieval). All participant-authored work in this
repository starts on or after 2026-08-12, per the hackathon rules.

## Measured results

<!--
  ══ NUMBERS BLOCK — the only place in this README that carries eval constants. ══
  Source of truth: eval/RESULTS.md. Never retype a number from it anywhere else in this file.
  Runs of record: rerunD-g5 (Errata) · rerunB-nothink (full-context) · rerunC-nothink (naive top-k).
  τ sweep: rerunE-g5. Judge validation: eval/judge-validation.md (committed 120-item control set).
  If a later eval wave changes the table, refresh THIS BLOCK ONLY and nothing else moves.
-->

**Errata leads overall — 53.3 vs 47.5 (full-context) and 45.8 (naive top-k RAG) — at 1/52nd the
context tokens, 1/523rd the $/question and 31× lower p50 latency than reading the full history, with
a citation on every answer.** It gets there while abstaining *more accurately* than full-context
(P 0.47 / R 0.93 against 0.58 / 0.80) rather than by answering more often.

| Arm | Overall | Info. extraction | Multi-session | Temporal | Knowledge update | Abstention P / R | Ctx tok/Q | $/Q | p50 / p95 (s) |
|---|---|---|---|---|---|---|---|---|---|
| **Errata** | **53.3 ± 0.0** | 44.7 ± 0.0 | **61.3 ± 0.0** | **30.3 ± 0.0** | **100.0 ± 0.0** | 0.47 / 0.93 | **2,095** | **$0.0000** | **0.26 / 1.22** |
| Full-context baseline | 47.5 ± 0.8 | **80.7 ± 1.5** | 35.5 ± 3.2 | 13.1 ± 1.7 | 61.1 ± 0.0 | 0.58 / 0.80 | 109,943 | $0.0110 | 8.00 / 8.68 |
| Naive top-k RAG (k=10) | 45.8 ± 0.0 | 63.2 ± 0.0 | 29.0 ± 0.0 | 21.2 ± 0.0 | 83.3 ± 0.0 | 0.41 / 0.98 | 4,665 | $0.0005 | 0.86 / 1.34 |

150 LongMemEval questions (`xiaowu0162/longmemeval-cleaned`, revision `98d7416c…`, sha256
`d6f21ea9…`), a seeded stratified subsample with **all 30 abstention questions included**; 3 seeds
(11/22/33) at temperature 0; the **same answer model and the same answer prompt sha across all three
arms**, verified against the deployed API before any spend. The four ability columns score the 120
non-abstention questions; abstention is scored deterministically by exact match and never reaches
the judge. Counting all 450 rows including abstention, the same runs read **Errata 61.3, naive 56.2,
full-context 54.0**. Errata's `$/Q` is $0.000021, not zero — the column rounds to four decimals.

**Honest gap, kept next to the headline.** Single-fact **information extraction is 44.7 against
full-context's 80.7** — the one column Errata loses, and it loses it badly. Cut by the corpus's own
question types, the entire remaining deficit is 22 of 150 questions:
`single-session-assistant` **7.1%** (against 92.9% for both baselines) and
`single-session-preference` **0.0%** (against 20.8% for full-context). Both are write-path gaps —
the fact is not in the graph to retrieve — and the first one is a **priced** decision, not a
modelling result: lifting the extraction cap that drops long enumerated assistant answers was
measured at **$20.72** to re-extract the 150 histories against the **$4.19** the shipped
configuration cost. Temporal is the one regression against the previously published run — 10 of 33
non-abstention temporal questions correct, down from 12 — inside the noise of a 33-question cell,
but a regression, and printed rather than dropped.

**The judge was validated before the table was believed.** False-accept rate **8.3%** (5/60) on
committed perturbed negatives against a ≤10% gate — **15.0%** before a disclosed control-set
revision that fixed 7 defective controls with the judge itself untouched; false-reject **0.0%**
(0/60) on paraphrased golds. Per family: **superseded-value 0.0% (0/12)** — the one category this
table's thesis rests on, so the judge cannot be fooled by an old value presented as current — and
**attribution-flip 25.0% (3/12), which FAILS its own gate and is published as a failure**, worst-case
75% once the six truncated verdicts are counted as accepts.

**τ was not fitted.** The abstention gate stays at its a-priori **0.35**; every abstention-positive
question the corpus owns is inside the reported test set, so a fitted τ would be in-sample and
saying otherwise would be false. A sensitivity sweep ships instead — overall is flat at 61.3 across
τ ∈ [0.20, 0.40], a plateau rather than a knife edge.

Full table, caption, before/after, and the failure taxonomy: [`eval/RESULTS.md`](eval/RESULTS.md) ·
[`eval/judge-validation.md`](eval/judge-validation.md) ·
[`eval/out/failure-taxonomy.md`](eval/out/failure-taxonomy.md).

<!-- ══ END NUMBERS BLOCK ══ -->

## How it works

Seven invariants, each one enforced somewhere you can open:

- **Claims are append-only.** Nothing is ever mutated or deleted — any mutation or deletion path is
  a bug, and there is no delete API to call. Re-ingesting a history is idempotent down to identical
  vertex ids (`packages/ingest` regression suite).
- **Bitemporal by construction.** Every claim and edge carries `event_time` (when it was true) and
  `ingest_time` (when we learned it), plus a `{session_id, turn_index, span}` citation, a
  confidence, and an `EXTRACTED`/`INFERRED` provenance tag.
- **Revision edges *are* the history.** A contradiction appends a new claim and a
  `SUPERSEDES`/`CONTRADICTS` edge from it to the claim it displaces (agreement appends `SUPPORTS`).
  The chain is the audit trail; there is no separate log to fall out of sync.
- **Beliefs are derived, never stored.** The belief for a `(subject, attribute)` pair is folded
  deterministically in app code from the claims and their revision edges (`packages/core`). *As-of*
  is the same fold behind an edge-time filter, which is why time travel is a query and not a feature.
- **Abstention is calibrated and first-class.** An evidence score `E` with five a-priori weights
  gates the answer at `E ≥ τ`; below it the API returns "not in the history" with the nearest-miss
  citations. It is scored in the results table like any other answer.
- **No vector store in the answer path.** Retrieval is entity-anchored graph traversal ranked by
  span-aware IDF coverage over attribute, value and the transcript's own evidence span. Embeddings
  appear in this repo exactly once — as the naive baseline arm being measured.
- **Hand-written Cypher against HydraDB's deliberate OpenCypher subset.** No ORM, no query-generating
  framework: the subset rejects undirected patterns, `IN`, `CONTAINS`, `IS NULL`, `RETURN *`,
  `min()`/`max()`, filtering `WITH` and unbounded `*` at parse time. Upsert is `MERGE {id}` then a
  single `SET`; writes go in ≤1024-row `UNWIND` batches over Bolt; vertex ids are 53-bit blake2b
  hashes minted in exactly one file. Reads are id-anchored, so the answer path never scans a label.

Read surface: `GET /api/belief` (current + as-of) · `GET /api/diff` (revision chain, cross-validated
against `algo.SPpaths`) · `POST /api/ask` (graph-retrieved material composed by the shared answer
model, or a calibrated abstention) · `GET /api/meta{,/health,/costs}`. Every answer carries its
citation; an uncited answer is a bug.

### What this project loses without HydraDB

The storage model. Supersession **is** append-only timestamped edges — HydraDB's own design
(*"updates commit new timestamped edges instead of overwriting"*). On a mutable store the revision
history this product sells would have to be faked; here it is the substrate doing exactly what it
was built to do, and time-travel and revision-diff are a few lines of hand-written Cypher rather
than an impossibility in a vector index. Everything we hit on the way — the writer-lease memory
ratchet, the label-scan admission-control ceiling, the strict `MERGE`/`SET` recognizer form, the
50× cost of anchoring a traversal from the wrong end — is measured and written down with its
workaround in [`docs/gauntlets.md`](docs/gauntlets.md), and rendered on the demo's `/limits` page.

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

# the demo: a pre-approval amount that was revised $350,000 → $400,000
curl -s 'http://127.0.0.1:8787/api/belief?subject=the%20user&attribute=mortgage_preapproval_amount'
curl -s -X POST http://127.0.0.1:8787/api/ask -H 'content-type: application/json' \
  -d '{"question":"What was the amount I was pre-approved for from Wells Fargo?"}'

ERRATA_API_URL=http://127.0.0.1:8787 pnpm dev:web                  # the app on localhost:3000
```

`pnpm verify` runs the three local gates (lint · typecheck · test); CI adds `pnpm audit` and the
license gate. The eval harness is standalone and talks to Errata only over HTTP:

```bash
cd eval && uv sync && uv run pytest        # harness tests, offline, no spend
uv run errata-eval sample --n 150 --print-ids   # the seeded comparison set, from the config alone
uv run errata-eval parity                  # /api/meta prompt+model gate, before any spend
```

Re-deriving the published table itself (`report --runs …`, `tau_sweep.py --run …`) needs the run
artifacts, which are gitignored as run outputs; the two committed deliverables they produced —
`out/report/table.md` and `out/failure-taxonomy.md` — are in the repo, as is the entire scored
120-item judge control set the FAR/FRR numbers are computed from. The exact command line for each is
recorded in [`eval/RESULTS.md`](eval/RESULTS.md).

## Eval integrity

The harness (`eval/`, Python 3.13 + uv) is **not** a workspace member and never imports the TypeScript,
never opens Bolt, never reads HydraDB — it talks to `POST /api/ask` and `GET /api/meta` over HTTP, so
anyone with the deployed URL reproduces the numbers. What that buys, concretely:

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

## Known limitations

- `single-session-assistant` and `single-session-preference` are where the arm loses; see the
  honest-gap paragraph above. Both are extraction-scope decisions, one of them explicitly bought at
  a price and disclosed rather than described as a model limitation.
- The judge's weak family is wrong-speaker attribution, published as a failing gate row.
- The full-context baseline runs on the 150-question subsample, not all 500, for cost reasons.
- Bulk ingest is **single-writer** with a memory guard sized to the box — parallel writers ratchet
  the node's RSS; the finding and the operating rule are in `docs/gauntlets.md`.
- Dark mode is a documented non-goal, not an omission: the app is a print metaphor and declares
  `color-scheme: only light`.

## The web app

`apps/web` (Next.js 16, App Router, React 19, Tailwind v4) serves five routes: **Ask** — the answer
with its struck predecessors, a live transcript column with a highlighter sweep on the cited span, a
per-answer economics line and the exact Cypher behind the answer; **Timeline** — the revision chain
replaying over event time, with a Constellation view of the same claims; **Compare** — vector
similarity against the belief graph; **Exhibit**; and **Limits**. Every number on screen comes from
the API at request time; nothing about an answer is hard-coded.

Three deliberate properties: **no UI, motion, icon or graph library** (the scrubber is
`<input type=range>`, the disclosure is `<details>`, the graph is ~60 lines of SVG physics, the icons
are Unicode glyphs — `apps/web` has **8 direct dependencies**); **nothing leaves the origin** (fonts
vendored as woff2 and loaded with `next/font/local`, the API reached through an origin-only
route-handler proxy, and a CSP of `connect-src 'self'` / `font-src 'self'` that enforces the promise
rather than asserting it); and **light-only, on purpose**.

## Layout, dependencies, attribution

`apps/web` (Next.js 16 → Vercel) · `apps/api` (Hono → pod) · `packages/core` (pure belief-revision
logic, vitest) · `packages/graph` (Bolt client + hand-written Cypher + blake2b ids) · `packages/llm`
(OpenRouter client + cost ledger) · `packages/ingest` (pipeline CLI) · `eval/` (Python 3.13, uv,
standalone).

Every dependency is pinned to an exact version (no `^`/`~` — CI greps for them and fails), the
lockfile is committed, and `allowBuilds` is empty: **no dependency may run an install script.** The
JS tree is deliberately small and entirely MIT / Apache-2.0 / BSD / ISC; a CI license gate fails
**closed** on strong copyleft (GPL/AGPL) and on a license report it cannot parse. The only hashing
dependency is **`@noble/hashes` (MIT)** — BLAKE2b for the 53-bit vertex
ids, chosen so the id math is byte-identical to the Python (`hashlib.blake2b`) side and pinned by
`packages/graph/fixtures/id-vectors.json` in both test suites.

Third-party components: **HydraDB** (consumed unmodified as a server over Bolt), **MinIO** (local
object store), **Hono**, **Next.js / React / Tailwind**, **neo4j-driver-lite** (Bolt wire protocol),
**OpenRouter** (all LLM calls, ledgered), **`BAAI/bge-small-en-v1.5`** (the naive baseline arm only),
and the fonts Fraunces, Inter and IBM Plex Mono (OFL 1.1, vendored). Dataset:
**`xiaowu0162/longmemeval-cleaned`**, pinned by revision and sha256 in `eval/eval.toml` and verified
by the harness; no private or self-collected data is used anywhere in this project.

## License

[Apache-2.0](LICENSE).
