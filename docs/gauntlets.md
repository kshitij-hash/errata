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
