# Gauntlet verdicts

Load-bearing queries are cross-validated against a running HydraDB before they are trusted (the
substrate is days old). Verdicts are captured here; throwaway probe code is deleted.

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
full 500 (§ backend sizing ~3 min graph write).

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
| `algo.MSpaths` with a list `sourceValues: $keys` | **rejected** — "composite parameter only supported as UNWIND input" | **co-mention expansion is cut to Tier-2** (pre-planned). The ask path uses id-pinned `UNION` arms, so nothing on the demo path depends on it |

**Driver/handshake anomaly + mitigation.** `neo4j-driver-lite@6.2.0`'s v2 (manifest) Bolt handshake
intermittently mis-negotiates with HydraDB — a `RangeError: offset out of range … Received 9` in the
driver's varint read (`handshakeNegotiationV2`), surfacing under concurrent connection-open. The same
error appears on a left-directed `(e)<-[:ABOUT]-(c) … LIMIT 5` returning many rows. Mitigations, both
in place: (1) `GraphClient.verify()` retries the handshake, recreating the driver on failure — the
full live suite then passes 129/129 across repeated runs; (2) the demo/ask path uses the
right-directed, id-anchored `MATCH (c:Claim)-[:ABOUT]->(e {id})` form, unaffected by the left-directed
case. Flagged for a possible upstream report (spec 33 §2.3 anticipated the legacy/manifest handshake risk).

**Verdict: PASS.** Loader usable, traversals stable, every load-bearing read form verified; the one
rejected primitive (MSpaths list param) was already the first Tier-2 cut.

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
salvage (P2-13) still runs on the response. Result: **22/22 first-attempt 200s, 149 claims
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

**Symptom (B5).** `mortgage_preapproval_amount` on the demo history held BOTH `$400,000` and
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
| Regression | `ingest.spec.ts` "re-ingest idempotence (B5)": assembling the same history twice yields identical counts AND identical vertex ids, so a second load adds nothing; plus `normValue` behaviour and the version-bump re-key |

**Method — a fresh namespace, not a wipe.** The ruling's wipe branch did not apply: today's funded
runs are in this graph (G3: 150 histories LLM-extracted + judged, $3.44, plus the full-500
structural store from Block A). Every vertex key is history-scoped (`h:<history_id>|…`), so the
clean re-ingest went into its own history-id namespace, `852ce960-clean` (`errata-ingest
--history-suffix`), a disjoint subgraph. **Nothing was wiped and nothing was deleted**; the original
`852ce960` and all 150 funded histories are untouched and still served. `ERRATA_DEMO_HISTORY` now
points at `852ce960-clean` (`.env.example`, `apps/web/config/demo-sessions.json`).

Both passes replayed entirely from the on-disk LLM cache: ledger total **$3.4404 before and after**
— the re-ingest cost **$0.00**.

**Counts — `852ce960` (before) vs `852ce960-clean` (after):**

| | Session | Turn | Speaker | Entity | Claim | SUPERSEDES | CONTRADICTS | SUPPORTS |
|---|---|---|---|---|---|---|---|---|
| before (3 passes, NORM_VERSION 1) | 39 | 396 | 2 | 30 | 199 | 4 | 0 | 1 |
| after (2 passes, NORM_VERSION 2) | 39 | 396 | 2 | 24 | 151 | 1 | 0 | 1 |

The before row is the live graph as found, which includes **2 claims + 2 SUPERSEDES edges appended
by the `POST /api/correction` smoke test** on the unused `battery_life_trend` attribute (extraction
alone accounted for 197 claims / 2 SUPERSEDES). The 48-claim drop is the un-reproducible first LLM
run (`r-852ce960-1786872342`, the free-form 45-claim pass that predates the strict-schema fix in
G2) plus the collapsed duplicate; the one attribute the demo needed from it, `job_title`, is
recovered by the registry synonym above. `mortgage_preapproval_amount` is now a two-claim,
single-threaded chain — `$400,000` superseding `$350,000` — and the API serves it with one
predecessor instead of two.
