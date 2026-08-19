# Gauntlet verdicts

Load-bearing queries are cross-validated against a running HydraDB before they are trusted (the
substrate is days old). Verdicts are captured here; throwaway probe code is deleted.

**Substrate under test.** Every verdict below was taken against
`ghcr.io/hydra-db/hydradb@sha256:db78309a233be54662db29744047e985a39b51c45a270d1a1f47c31a62cdb709`
— the digest pinned in `docker-compose.yml` and `deploy/pod/Dockerfile`, published 2026-08-12 from
hydra-db/hydradb `02a40025d2d57e97ab2754c8256219cdbfeab379`. The image is labelled **v0.1.1**; the
`graph-node` binary inside self-reports **0.1.0** in every log line. We cannot reconcile the two
from here, so the digest is the identifier to quote — it is the only one that is unambiguous. The
running node exposes no version over HTTP: the admin port (9090) serves `/readyz` and `/metrics`
and nothing else, and `/metrics` carries no `build_info`.

## G0 — Bolt round-trip smoke (Day 0) — PASS

`neo4j-driver-lite@6` over `bolt://127.0.0.1:7687`, `disableLosslessIntegers: true`. Two binding
laws, now enforced in `packages/graph`:

1. **Every integer param is wrapped `neo4j.int()`** at one choke point (`toBoltParams`). A plain JS
   number is sent as a Bolt Float and HydraDB rejects id fields. Reads use `disableLosslessIntegers`.
2. **Edge writes are a single comma-joined `MATCH (s),(d) MERGE (s)-[r:T {id}]->(d) SET …`.** Edge
   ids are integers we allocate (`edge:TYPE:srcKey:dstKey` → 53-bit hash).

## G1 — Two-phase loader + traversal + subset probes (2026-08-16) — PASS

**Loader.** History `852ce960` (39 sessions, 396 turns) ingested in **215 ms** (5 node + 6 edge
batches, ≤1024 rows each, single serialized writer). Traversal reads return stable, correct rows
after the write, using causal reads pinned to the ingest bookmark. Extrapolates comfortably to the
full 500 (~3 min projected graph write).

**Vertex/edge upsert form — the recognizer is strict.** HydraDB has a fast-path recognizer for
`UNWIND … MERGE by id … SET`. Verified by probe:

| Form | Result |
|---|---|
| `MERGE (n {id}) SET n:Label, n.a = …, n.b = …` (single SET, label folded in) | **accepted** |
| `MERGE (n:Label {id}) SET …` (label in MERGE pattern) | rejected — "apply labels with SET" |
| `MERGE (n {id}) SET n:Label SET n.a = …` (two SET clauses) | rejected |
| edge `MERGE (s)-[r:T {id}]->(d)` **without** `SET` | parse error |

→ `cypher.ts` emits exactly the accepted form (label in the node SET; a single `SET` for edges).

**Subset probes (previously unverified in the reference):**

| Probe | Verdict | Consequence |
|---|---|---|
| Left-directed `<-` patterns | **supported** (anchor-first `(e)<-[:ABOUT]-(older)<-[:SUPERSEDES]-(newer)` returns rows) | a planner-safe fallback exists for the revision query |
| Multi-element `relTypes: ['SUPERSEDES','CONTRADICTS']` in `algo.SPpaths` | **supported** | diff can merge both relations in one call |
| Planner `full_scan` on the end-anchored revision query | **none logged** | id-anchored reads do not full-scan; the current builder is safe on the demo path |
| `algo.SPpaths` (single relType) | works, returns `Path` | diff primitive confirmed |
| `algo.MSpaths` with a list `sourceValues: $keys` | **rejected** — "composite parameter only supported as UNWIND input" | **co-mention expansion is deferred by design.** The ask path uses id-pinned `UNION` arms, so nothing on the demo path depends on it |

**Driver/handshake anomaly + mitigation.** `neo4j-driver-lite@6.2.0`'s v2 (manifest) Bolt handshake
intermittently mis-negotiates with HydraDB — a `RangeError: offset out of range … Received 9` in the
driver's varint read (`handshakeNegotiationV2`), surfacing under concurrent connection-open. The same
error appears on a left-directed `(e)<-[:ABOUT]-(c) … LIMIT 5` returning many rows. Mitigations, both
in place: (1) `GraphClient.verify()` retries the handshake, recreating the driver on failure — the
full live suite then passes 129/129 across repeated runs; (2) the demo/ask path uses the
right-directed, id-anchored `MATCH (c:Claim)-[:ABOUT]->(e {id})` form, unaffected by the left-directed
case. Flagged for a possible upstream report; the legacy/manifest handshake was a known risk area going in.

**Verdict: PASS.** Loader usable, traversals stable, every load-bearing read form verified; the one
rejected primitive (MSpaths list param) was already scoped out of the demo path.

## G2 — funded LLM extraction + conflict judge (2026-08-16) — PASS

First funded run, demo history `852ce960` (39 sessions, 396 turns), extractor
`openai/gpt-5.6-luna`, judge `google/gemini-3.7-flash`, via OpenRouter.

**Finding — strict-mode 400s from the loose request schema.** The extractor requested structured
output with `LooseExtractSchema` (`claims: unknown[]`), whose JSON Schema contains `items: {}`;
OpenAI's strict mode rejects that with HTTP 400 on EVERY unit. The client's repair path then
retried WITHOUT `response_format`, so the run "worked" — at double the calls and with free-form
output. Worse, free-form mode badly under-extracted: **52 claims, 0 supersessions, and the demo's
own mortgage facts missed** (only the rule extractor's overlay saved the answer).
**Fix:** request with the STRICT `ExtractSchema` (server-enforced structure); the per-claim loose
salvage still runs on the response. Result: **22/22 first-attempt 200s, 149 claims
(~2.9×), both mortgage claims extracted, 1 judge call → `SUPERSEDES $350,000 → $400,000`**, and
`/api/ask` serves `$400,000` with the correct Nov-30 citation. Cost: $0.039 for both runs.

**Note — value normalization across extractors.** The LLM wrote `400000 USD` where the rule pass
wrote `$400,000`; the differing `value_norm` minted two claim vertices (each correctly superseding
$350,000). Harmless append-only duplication on the doubly-ingested demo history; a corpus run uses
one extractor, so chains stay single-threaded there.

**Throughput.** 133 s/history sequential → extraction batches now run 6-wide per history
(order-preserving slots), and the CLI gained `--ids-file` for the eval's sample-150 run.

## G3 — sample-150 funded ingest + the OOM/lease root cause (2026-08-16) — PASS, RCA COMPLETE

All 150 eval-sample histories ingested with LLM extraction + conflict judge (150/150 verified
serving claims; $3.44 total spend, every response disk-cached so every replay was $0). Getting
there surfaced a chain of substrate failures; the root cause was found and fixed, not worked around.

**Root cause — writer-lease churn re-opens SlateDB and ratchets RSS to OOM.** The node holds a
writer lease per cell (`GRAPH_WRITER_LEASE_MS`, default 30 s). When no write lands within the TTL
it demotes its writer; the NEXT write runs `writer.promote`, which **re-opens the entire SlateDB
database** (manifest read, WAL fence, fresh allocations). Measured: 22 re-opens in ~10 min (lease
generation 25→46), RSS flat at 4.9 GiB at idle afterwards — ~200 MB retained per re-open, never
returned. Our ingest interleaves 30–90 s LLM gaps between write bursts, so the default lease
churned once per history → hundreds of re-opens across a run → RSS climb → the 8 GB Docker VM's
kernel SIGKILLs the node (`OOMKilled=true`, exit 137).

**Cascade 2 — the image ships `StopTimeout=1`.** Every docker stop/restart SIGKILLed the node after
ONE second, so even "graceful" restarts never flushed or released the lease (zero shutdown lines in
any log all day). The killed instance's lease then shadows the cell: the fresh node reports healthy
(readyz does not test write ownership) but rejects writes with `cell cell-0 is not owned by this
node` until TTL expiry.

**Cascade 3 — client stampede.** The CLI failed each history in ~2 s and moved on, burning 45
histories through a 30 s shadow instead of waiting once. "Persistent corruption" was actually a
30-second wait-condition raced at 2 s per attempt.

**Fixes (each at its causal layer):**
| Layer | Fix |
|---|---|
| Lease churn (root) | `GRAPH_WRITER_LEASE_MS=120000` — outlives the LLM gaps; writer stays promoted, no re-opens |
| 1 s SIGKILL | compose `stop_grace_period: 60s` — first clean `"graph node stopped"` ever logged; post-restart write OK in 132 ms, shadow gone |
| Shadow stampede | `writeWithRetry` treats `is not owned by this node` as a wait-condition (20/40/60 s backoff) |
| Memory ceiling | ingest CLI `--mem-guard-gb` polls node RSS per history; graceful drain-and-restart at a HISTORY BOUNDARY before the kernel acts |
| Query timeout | 30 s `Transaction.Terminated` on MERGE batches under compaction debt → idempotent retry 2/4/8 s |
| Data-model bug (ours) | claim whose value entity == subject entity emitted two ABOUT edges with one id → HydraDB idempotency-key conflict; SUBJECT wins now |
| Strict-output 400s (ours) | loose `items:{}` schema rejected by OpenAI strict mode per unit; strict `ExtractSchema` on the request tripled extraction recall (52→149 claims on the demo) |

**Deploy note:** the pod must carry the same posture — long writer lease, real stop grace, a memory
watchdog — and the churn finding is worth an upstream report: lease demotion on write-idle plus
re-open-on-promote is a memory ratchet on any bursty writer.

## Block B — the "unhealthy" HydraDB container (2026-08-16) — FIXED

`errata-hydradb-1` reported `unhealthy` (FailingStreak 667) while serving correctly (live suite
129/129). **Root cause:** the compose healthcheck ran `curl -fsS …/readyz`, but the upstream image
ships **no curl, no wget, no nc** — only `bash` (it is otherwise a full Debian). The probe failed
with `/bin/sh: 1: curl: not found`, never the server.

**Fix:** a `bash /dev/tcp` probe of `/readyz` on the admin port (9090), single-quoted in YAML so the
`\r\n` reach bash's `printf`:
`bash -c 'exec 3<>/dev/tcp/127.0.0.1/9090 && printf "GET /readyz HTTP/1.0\r\n\r\n" >&3 && head -1 <&3 | grep -q " 200"'`.
From a cold `stack:up`, `docker ps` shows **healthy in ~10s** (start_period 15s, then 3s interval).

**Deploy note (for later):** the pod's supervisord image must not assume curl/wget exist either —
its readiness/liveness probes need the same bash form or a static probe binary added to the image.

## Block A — full-500 structural ingest (2026-08-16) — DONE

Structural-only pass (Session/Turn/Speaker + STATED_IN — zero LLM, zero tokens) over all 500
LongMemEval histories into HydraDB+MinIO.

- **500/500 histories · 246,750 turns** (== the corpus total) · ~25K sessions · 1000 speakers · 0
  claims (structural only). 1500 node + 1000 edge batches (≤1024 rows, single serialized writer).
- **Rate:** 386.6 s total, **773 ms/history, 1.3 hist/s**. The rate degrades from ~2.4 → ~1.3
  hist/s as the store grows (SlateDB write amplification on a growing bucket — expected).
- **Verified 5/5** — `countLabel(Session/Turn)` equals the reader's counts, including BOTH
  duplicate-session_id histories (58bf7951 57/616, caf03d32 51/493): the ordinal-key fix holds.
- **Store 8.4 GiB**; `mc mirror` backup → `backups/hydra` (8.42 GiB in 17 s).

**Key finding — duplicate session_ids (13 of 500).** Some histories reuse a session_id within the
history (different dates/turns). Keying Session/Turn/Claim vertices on session_id minted the SAME id
twice with conflicting `event_time`; HydraDB rejected the batch (`conflicting metadata values for
vertex … property event_time`). The first `--all` run died on `58bf7951`. **Fix:** sessions/turns/
claims key on the positional ordinal (`packages/graph/src/ids.ts`); session_id is a display property.

**Key finding — countLabel is a label scan.** `MATCH (n:Label) WHERE n.history_id = $h RETURN
count(*)` scans the whole label (246K Turn nodes) per call — seconds each on the full graph. It is
admin-only (`/api/meta/health`), never on the id-anchored demo path, but do not move it onto a hot
path without batching/caching it.

## G4 — the demo history's forked claim chain (2026-08-16) — FIXED BY RE-INGEST, NOTHING DELETED

**Symptom.** `mortgage_preapproval_amount` on the demo history held BOTH `$400,000` and
`400000 USD` as separate claim vertices, each superseding `$350,000`. The answer card had to hide
one of them (`lib/format.ts: sameValue`) so the hero answer did not read "$400,000, superseding
400000 USD, superseding $350,000".

**Root cause — value normalization, not double ingest.** `852ce960` was ingested by three passes
(two LLM runs and one rule run). The rule extractor wrote `$400,000`; the LLM extractor wrote
`400000 USD` — the same sentence, the same session, the same turn index, the same fact. `normText`
strips the `$` and the comma but leaves the digit grouping and the trailing currency word, so the
two surface forms produced different `value_norm`, hence different claim natural keys, hence two
vertices. Multiple extractors over one history is legitimate and useful (the rule pass is what
nails the two mortgage facts; the LLM pass supplies the other 149 claims) — what was broken is that
two spellings of one amount could not meet on one vertex.

**Fixes, each at its causal layer:**

| Layer | Fix |
|---|---|
| Value identity (root) | `normValue` (packages/ingest/src/text.ts) canonicalizes a bare monetary amount to `<digits> <iso-code>`, reading the currency symbol off the RAW string before `normText` eats it. `$400,000` and `400000 USD` → `400000 usd` → ONE vertex. Deliberately narrow: any other word in the value leaves it untouched, currencies stay distinct, and a marker-free `400000` is never assigned a currency it never had |
| Silent re-keying | the normalizer's version (`NORM_VERSION`, now 2) is an INPUT to `keys.claim` / `keys.correction`, so a normalization change moves a whole generation of claim ids visibly instead of silently merging or splitting claims |
| Lexicon clobber | `writeLexicon` MERGES into the lexicon already on disk. It used to overwrite, so in a two-extractor ingest whichever pass ran last narrowed the ask path's anchors to its own entities |
| Attribute drift | `current_job_title` added to the `job_title` synonyms — the LLM extractor's own name for it on this history, previously landing unregistered |
| Regression | `ingest.spec.ts` "re-ingest idempotence": assembling the same history twice yields identical counts AND identical vertex ids, so a second load adds nothing; plus `normValue` behaviour and the version-bump re-key |

**Method — a fresh namespace, not a wipe.** A full wipe was ruled out: the day's funded
runs are in this graph (G3: 150 histories LLM-extracted + judged, $3.44, plus the full-500
structural store from Block A). Every vertex key is history-scoped (`h:<history_id>|…`), so the
clean re-ingest went into its own history-id namespace, `852ce960-clean` (`errata-ingest
--history-suffix`), a disjoint subgraph. **Nothing was wiped and nothing was deleted**; the original
`852ce960` and all 150 funded histories are untouched and still served. One discarded intermediate
namespace, `852ce960-r2`, was written before the `normValue` fix landed and is likewise left in
place — disposable dev storage, and nothing points at it. `ERRATA_DEMO_HISTORY` now
points at `852ce960-clean` (`.env.example`, `apps/web/config/demo-sessions.json`).

Both passes replayed entirely from the on-disk LLM cache: ledger total **$3.4404 before and after**
— the re-ingest cost **$0.00**.

**Counts — `852ce960` (before) vs `852ce960-clean` (after):**

| | Session | Turn | Speaker | Entity | Claim | SUPERSEDES | CONTRADICTS | SUPPORTS |
|---|---|---|---|---|---|---|---|---|
| before (3 passes, NORM_VERSION 1) | 39 | 396 | 2 | 30 | 199 | 4 | 0 | 1 |
| after (2 passes, NORM_VERSION 2) | 39 | 396 | 2 | 24 | 151 | 1 | 0 | 1 |

Both rows are the live graph as found, and both include claims appended by the `POST /api/correction`
smoke tests on the unused `battery_life_trend` attribute — 2 claims + 2 SUPERSEDES edges in the
before row (ingest alone: 197 claims / 2 SUPERSEDES), 1 claim + 1 SUPERSEDES edge in the after row
(ingest alone: 151 claims / 1 SUPERSEDES). They are left where they are rather than cleaned up:
there is no deletion path, and that is the point. The 48-claim drop is the un-reproducible first LLM
run (`r-852ce960-1786872342`, the free-form 45-claim pass that predates the strict-schema fix in
G2) plus the collapsed duplicate; the one attribute the demo needed from it, `job_title`, is
recovered by the registry synonym above. `mortgage_preapproval_amount` is now a two-claim,
single-threaded chain — `$400,000` superseding `$350,000` — and the API serves it with one
predecessor instead of two.

## G5 — the 51.3-vs-56.2 deficit: failure taxonomy, then the fix (2026-08-17) — PASS

**Verdict: PASS.** Errata went from losing to both baselines to leading both. Overall (the 120
non-abstention questions) **41.7 → 53.3** against full-context 47.5 and naive 45.8; counting all 450
rows including abstention, **51.3 → 61.3** against 54.0 and 56.2. Answered-precision rose at the
same time, **61.7% → 70.3%**, so the arm did not buy the number by answering more. Full table and
caption: `eval/RESULTS.md`.

### The taxonomy came first, and it moved the diagnosis

`eval/failure_review.py` joins a run's answers + judgments with the gold corpus and replays every
question through `POST /api/ask` with a new opt-in `debug: true` trace (anchors, the ranked
material, the exact gate that fired). The answer LLM is served from Errata's on-disk cache, so
replaying an already-run question is $0 — the whole analysis cost nothing.

The going-in diagnosis was that question phrasing fails the exact-token lexicon lookup, so the ask
never anchors. **The trace says that was 1 of 42 over-abstentions.** Anchors resolved and a median
of 181 claims came back on nearly every question. What was broken was one layer further in:

| Before, measured | |
|---|---|
| over-abstentions on answerable questions | 42 of 120 (35%) |
| …that never resolved an anchor | **1** |
| …that reached the model with material not containing the answer | 39 |
| questions where NO question token matched any lexicon term | 67 of 150 |
| claims reachable from anchors, median | 181 |
| claims that reached the model | **12**, ranked by a token-F1 that was 0 for most of them |
| the evidence span, the field carrying the transcript's own wording | **not scored at all** |

And cutting the same run by the corpus's own `question_type` instead of by `ability` — `ability`
folds three single-session types into one column — showed the rest of it: **Errata already beat or
matched both baselines on every question type except `single-session-assistant` (0.0% vs 92.9% and
92.9%) and `single-session-preference` (0.0% vs 20.8% and 0.0%).** Those 22 of 150 questions were
the entire headline gap, and they were not a retrieval failure at all: the salience gate dropped
assistant turns unless they contained a first-person cue, and the extraction prompt asked only for
"durable personal facts stated by the user", so the fact was never in the graph to retrieve.

Also verified in the same pass: all 150 sampled histories had extracted claims (127–269 each). No
history-level extraction hole.

### Fixes

| Layer | Fix |
|---|---|
| Answer-path ranking | `packages/core/src/lexical.ts` — lemma-lite stemming, `normValue`-v2-shaped number/currency/date canonicalization, and IDF-weighted **asymmetric** coverage over attribute + value + **evidence span**. Replaces `tokenF1(question, attribute + " " + value)` everywhere the ask path ranked |
| Anchoring | SELF is now **always** an anchor, not only on first-person questions. A question naming one rare entity used to narrow retrieval to that entity alone (one case reached the model with 1 claim out of 147); a question naming nothing resolved to zero anchors and abstained without a read. Bigram probes catch multi-word entity names; a most-mentioned-entity fallback catches the rest |
| Material window | 12 → `ERRATA_MATERIAL_MAX` (30) claims. Prompt goes 923 → 2,095 tokens/question — still 1/52nd of full-context |
| Write-side aliases | `packages/ingest/src/aliases.ts` — ONE extractor-model call per history produces entity surface forms and, for each attribute, the phrasings a person would ASK with (`direct_report_count` → "team size", "how many people", "reports"). Baked into the lexicon artifact; a frozen string→string map by the time a question arrives, so the answer path stays model-free and vector-free (hard rule 2) |
| Extraction scope | The prompt now names all six things the corpus asks about — profile facts, quantities with units, dates/plans, preferences, reported events, and **substantive content the assistant provided** |
| Salience | `isSalient` keeps a session's main substantive assistant reply (≥40 tokens, following a salient user turn, one per session), not only assistant turns that restate a user fact |
| Calibration | E's `s` term now takes the same relevance the retrieval used, via a `fit` field on `ScoredClaim`, instead of recomputing a worse number |

Effect on the front door: questions where no token matched the lexicon went **67 → 4** of 150;
claims per history **127–269 → 392–571**; over-abstentions **42 → 31**; anchor failures **1 → 0**.

### Write-path economics — the $20.72-projected prompt that was priced and rejected

Extraction cost is ~92% output tokens, so scope and volume are separate dials and only one of them
is affordable. The first cut of the broadened prompt ended with "prefer many small specific claims
over one broad one", measured **6,077 output tokens per 12-turn batch** (≈7 claims per turn), which
projects to **$20.72** to re-extract the comparison-150 — 6x the old pass and 4x the budgeted
ceiling. The tokens were measured; the $20.72 is a projection from them and was never spent, so it
is called projected everywhere in this document.
Two cheaper extractors were tried and both failed on quality, not price: `qwen/qwen3.7-flash`
returned 0 claims across 34 batches (reasoning ate the whole budget — the Arm-B incident again, now
fixed by `reasoningEnabled: false` on the extraction call, which every extractor benefits from), and
`deepseek/deepseek-v4-flash` came in at $3.38/150 but abstained on the validation question and ran
at 6.2 min/history. The shipped configuration keeps `openai/gpt-5.6-luna`, caps the prompt at 10
claims per batch behind a 2,400-token hard ceiling, and caps assistant replies at one per session:
**915 output tokens/call, $4.19 for all 150 histories, 104 minutes.**

That cap is also why `single-session-assistant` only reached 7.1%. A ten-item enumerated assistant
answer cannot survive a 10-claim batch shared with 11 other turns. The chess case ("the move after
27. Kg2 Bd5+" → "28. Kg3 Be6") works end to end; the list cases do not. It is a priced, disclosed
budget decision and it is written down as one rather than described as a model limitation.

### Operational finding — HydraDB is a single-writer store under bulk ingest

Sharding the re-extraction three ways to save wall-clock ratcheted the node's RSS from 3.7 GiB to
**6.3 GiB in ~9 histories** and would have reached the 7.75 GiB VM ceiling long before 150. Reverted
to **one writer with `--mem-guard-gb 5.0`**: the existing graceful drain-and-restart fired **15
times across the run, all clean, zero failed histories**, and RSS oscillated between ~20 MiB and 5
GiB instead of climbing. The G3 lease RCA fixed the *corruption* mode; this is the *capacity* one,
and the operating rule that follows is: **bulk ingest is single-writer, and the writer needs a
memory guard sized to the box.** For the deployed pod: 16 GB and one ingest process, not N.

One related limit surfaced at the new store size: `GET /api/meta/health` returned 503 with
`cypher_vertex_label_index_candidates rejected by admission control: actual 250001 exceeds limit
250000`. That was the `countLabel` **label scan** in the admin health route meeting HydraDB's
admission control now that the store holds the full-500 structural corpus plus 42,682 new claims.
It never touched `/api/ask`, which is id-anchored and never scans — which is rather the point of
the id-anchored read discipline, and which is also how it was fixed: **the health route now counts
id-anchored too** (`apps/api/src/health.ts`). Speakers and Sessions are minted ids, Turns are the
sum of each Session's own `turn_count`, and the Entity/Claim traversals are opt-in behind
`?counts=deep`. Live: 503 → **HTTP 200 in 15 ms–1.2 s** on the demo history, with
`?counts=deep` returning the same numbers the old label scan did (Claim 152, Entity 24). Three
findings fell out of doing it, all measured against the live store:

> **Superseded at the current store size.** Those deep counts no longer reproduce. The typed
> backfill has since added 271,544 Claim vertices, so the **Claim label itself** now exceeds the
> same ceiling (`actual 250001 exceeds limit 250000`) — the second time admission control was hit,
> and this time it is the label, not one route's scan. The remaining label scan is the debug-only
> `claimsForHistory` replay the failure taxonomy uses, and it was failing the ENTIRE ask with a 500.
> It now **degrades to an empty list** instead (`apps/api/src/query.ts`, the `opts.debug` branch),
> so the taxonomy's extraction-gap denominator is simply unavailable at this size rather than
> fatal. `/api/ask` proper is unaffected in both incidents for the same reason: it is id-anchored
> and never scans.

- **A label scan's candidate set is the whole LABEL, not the filtered subset.** Adding a `LIMIT`
  does not help — the same reads then time out at 30 s instead. `Speaker`, two nodes per history,
  timed out for exactly this reason.
- **Anchor-first is a 50x, not a style preference.** `(e:Entity)<-[:ABOUT]-…-(s:Session {id})`
  measured 1,233 ms per arm; the same four hops written `(s:Session {id})<-…->(e:Entity)` measured
  22 ms. At 52 UNION arms the first form blows the 30 s query timeout and the second does not.
- **An abandoned query keeps running.** A client that stops waiting does not stop the engine, so a
  health *poll* that took the traversal would slowly starve the store it reports on. That, not the
  503, is why the deep counts are opt-in rather than merely budgeted. The diagnostic `claimsForHistory` scan added for the taxonomy is
heavy enough that 8 concurrent replays drop a Bolt connection; `failure_review.py` runs 3 at a time
with retries, and that path is never on the demo or eval route.

### τ was not re-fitted, and that is the finding

A held-out fit needs abstention-positive examples. LongMemEval has exactly 30 and
`sample.abstention_whole = true` puts all 30 inside the comparison set by design, so every
abstention-positive example the corpus owns is inside the reported test set and any τ fitted against
them is in-sample. τ stays at its a-priori **0.35** and `eval/tau_sweep.py` publishes the
sensitivity instead: overall is flat at 61.3 across τ ∈ [0.20, 0.35] and falls from 0.40 (60.0), so
the result is a plateau rather than a knife edge. On the *previous* run the same veto at τ = 0.35 would have cut overall
from 51.3 to 35.3 — E and τ were on different scales, and a veto is not something to switch on
quietly. Reasoning and table: `eval/RESULTS.md`.

### One regression found after the run, and how it was closed

Picking the BELIEF's coordinates from the top-ranked material claim broke the flagship demo: "How
much was I pre-approved for by Wells Fargo?" names the lender, so the lender claim wins on body
coverage, and the answer card opened `mortgage_lender` with no struck predecessor instead of
`mortgage_preapproval_amount` with its $350,000. The answer text was right throughout — only the
v1.1 additive coordinates were wrong. Fixed by scoring the belief attribute-led (0.7 attribute /
0.3 body) while the material stays body-led, and by letting the attribute registry's own synonyms
(`pre approved amount`) into the ask path's vocabulary alongside the generated ones. Verified rather
than asserted: `rerunE-g5` re-ran all 450 rows on the fixed build, **0 of 450 answers differ** from
`rerunD-g5`, and an independent re-judge reproduced every published number. `rerunD-g5` stays the
run of record because `rerunE-g5` answered from a warm cache and its latency is not representative.

### Spend

Incremental spend **$5.59**: $0.53 exploratory (including the $20.72-projected prompt and the two
rejected extractors), $4.19 re-extraction + alias pass over 150 histories, $0.01 for 450 answers
(**$0.000021/question**), $0.87 judge across the two runs. Ingest ledger $8.18 of a $50 cap; eval
ledger $12.10 of the then-$13.00 cap (raised to $15.00 the same day to fund the 120-item
judge-validation pass — `eval/eval.toml`, `spend.hard_cap_usd`). Six disposable probe namespaces (`-g5probe`, `-g5b`, `-g5q`, `-g5q2`, `-g5ds`, `-g5f`)
are left in the store: nothing points at them, and there is no deletion path.

The re-extraction was an **append into the same history namespaces**, not a wipe — every old claim
still has its id, value, citation and confidence, and the new pass simply added more. That is the
same invariant G4 relied on, exercised at 150-history scale.
