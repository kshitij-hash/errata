# `errata-mcp` demo: an agent correcting its own memory mid-conversation

This transcript is **real**, not written by hand. It was captured by running
[`packages/mcp/scripts/demo.mjs`](../packages/mcp/scripts/demo.mjs) — a small MCP client that spawns
`packages/mcp/dist/index.js` over stdio, exactly the way Claude Desktop or Claude Code would — against
a live stack: `docker compose up` (HydraDB + MinIO) and `apps/api` on `127.0.0.1:8787`, with the demo
history `852ce960-clean` (the re-ingested, single-threaded version of `852ce960` — see
`docs/gauntlets.md` G4) and a funded OpenRouter key, so `/api/ask` answers via the real
`errata-graph-synthesis@2` LLM path, not the deterministic fallback.

Every JSON block below is pasted verbatim from that run (2026-08-18, `trace_id`s and `claim_id`s are
real). Command:

```
pnpm typecheck                      # builds packages/mcp/dist
node packages/mcp/scripts/demo.mjs > transcript.json
```

The one write in this transcript (`memory_correct`) landed on the demo history, `852ce960-clean` — the
ground rule for this build ("append only to the demo history or a synthetic session, never an
eval-sample history, keep writes minimal") — and appends exactly one claim + one SUPERSEDES edge. It
is still there: append-only means there is no path to take it back, which is the entire point of the
demo.

Tools registered by the server (`tools/list`, captured from the same run):

| tool | description |
|---|---|
| `memory_ask` | Ask the memory a question. Returns the current belief with its citation, confidence, and superseded prior values — or a calibrated abstention with nearest-miss citations. |
| `memory_remember` | Record a new observation as a claim. Supersedes an existing belief for the same (subject, attribute); rejected with a structured reason if this history has never held any claim about it. |
| `memory_correct` | Record a correction, optionally naming the exact claim it supersedes. Returns the resulting revision chain. |
| `memory_history` | The revision chain for one (subject, attribute): every claim that ever held, current values unstruck, superseded values struck alongside what displaced them. |

---

## 1. Agent asks memory a question — gets a cited answer

```jsonc
// memory_ask({ question: "What was the amount I was pre-approved for when I got my mortgage from Wells Fargo?", history_id: "852ce960-clean" })
{
  "abstained": false,
  "answer": "$400,000",
  "confidence": 0.5604639747580824,
  "claim_confidence": 0.72,
  "corroboration": 1,
  "disputed": false,
  "subject": "the user",
  "attribute": "mortgage_preapproval_amount",
  "citations": [
    { "session_id": "answer_3a6f1e82_1", "turn_index": 2, "span": "pre-approved for $350,000 from Wells Fargo.", "claim_id": 6341458025447090 },
    { "session_id": "answer_3a6f1e82_2", "turn_index": 0, "span": "pre-approved for $400,000 from Wells Fargo?", "claim_id": 6423372368317097 },
    { "session_id": "answer_3a6f1e82_2", "turn_index": 0, "span": "I got pre-approved for $400,000 from Wells Fargo", "claim_id": 3283595309687236 }
  ],
  "superseded": [
    { "value": "$350,000", "attribute": "mortgage_preapproval_amount", "event_time": 1691712060, "citation": { "session_id": "answer_3a6f1e82_1", "turn_index": 2, "claim_id": 6341458025447090 }, "evidence_span": "pre-approved for $350,000 from Wells Fargo." }
  ]
}
```

The answer is right (`$400,000`), it names a citation, and it already shows the value it displaced
(`$350,000`) — this is the flagship supersession from `docs/gauntlets.md` G2/G4, served live.

## 6 (shown here, since it costs nothing to interleave). An abstention — first-class, not an error

```jsonc
// memory_ask({ question: "What is my favorite color?", history_id: "852ce960-clean" })
{
  "abstained": true,
  "reason": "not_in_history",
  "confidence": 0.4638602313674934,
  "nearest_miss": [
    { "attribute": "favorite_book_interest", "value": "was hooked after finishing The Name of the Wind", "s": 0.812867, "citation": { "session_id": "e8bfacec_1", "turn_index": 0 }, "span": "I just finished reading \"The Name of the Wind\" today and I'm hooked!" },
    { "attribute": "energy_usage_phone_app", "value": "uses an app on their phone to track energy usage", "s": 0, "citation": { "session_id": "a110c4dc_1", "turn_index": 6 }, "span": "similar to the one I've been using on my phone" },
    { "attribute": "weekly_child_activity", "value": "Their kids attend soccer practice every Saturday morning", "s": 0, "citation": { "session_id": "010a28ab_3", "turn_index": 6 }, "span": "my kids' soccer practice every Saturday morning" }
  ]
}
```

`tool_result.isError` is `false` here — the MCP call succeeded; the *content* of the answer is "I
don't know," with the three nearest misses so the caller can see why (`s` is each candidate's
relevance score against the question — the top one, `0.81`, is still nowhere near a real match on
favorite color).

## An honest gap, surfaced structurally: `memory_remember` on a fact the history never held

```jsonc
// memory_remember({ subject: "the user", attribute: "favorite_color", value: "blue", history_id: "852ce960-clean" })
{
  "appended": false,
  "reason": "unknown_subject_attribute",
  "message": "unknown subject/attribute for this history: no claim about 'the user' with attribute 'favorite_color' in 852ce960-clean"
}
```

apps/api's only mutating route, `POST /api/correction`, can append a claim only when the (subject,
attribute) already has at least one claim to attach a SUPERSEDES edge to — a genuinely first-ever fact
requires the offline, LLM-backed ingest pipeline (`packages/ingest`), which this MCP server
deliberately does not call (see "API gaps" in the README). `memory_remember` reports that plainly
instead of pretending to write it.

## 2/3. User corrects the agent → agent calls `memory_correct`

The user (not scripted — this is the demo's real corrective act): *"Actually, that pre-approval was
increased to $425,000."* The agent calls:

```jsonc
// memory_correct({ subject: "the user", attribute: "mortgage_preapproval_amount", value: "$425,000", history_id: "852ce960-clean" })
{
  "appended": true,
  "claim_id": 1675875085541886,
  "edge_id": 4231840648279542,
  "event_time": 1787050447,          // 2026-08-18T10:54:07Z — the instant this correction was filed
  "supersedes_claim_id": 6423372368317097,   // the $400,000 claim
  "citation": { "session_id": "user-correction", "turn_index": -1, "span": "correction, claim 1675875085541886", "claim_id": 1675875085541886 },
  "revision_chain": {
    "found": true, "subject": "the user", "attribute": "mortgage_preapproval_amount",
    "current": [
      { "value": "$425,000", "event_time": 1787050447, "struck": false, "citation": { "session_id": "user-correction", "turn_index": -1, "claim_id": 1675875085541886 } },
      { "value": "$400,000", "event_time": 1701304560, "struck": true, "citation": { "session_id": "answer_3a6f1e82_2", "turn_index": 0, "claim_id": 6423372368317097 } },
      { "value": "$350,000", "event_time": 1691712060, "struck": true, "citation": { "session_id": "answer_3a6f1e82_1", "turn_index": 2, "claim_id": 6341458025447090 } }
    ],
    "disputed": false, "contested": false, "chain_len": 3, "revisions": [], "truncated": false
  }
}
```

Note the citation on the new claim: `session_id: "user-correction"`, `turn_index: -1`. That is not a
placeholder — it is the graph being honest about provenance (`apps/api/src/correction.ts`, via
`@errata/ingest`'s `buildCorrection`): this claim did not come from a transcript turn, it came from the
conversation happening right now. Hard rule 3 ("every answer carries a citation") holds either way.

## 4. `memory_history` — the SUPERSEDES chain, struck values included

```jsonc
// memory_history({ subject: "the user", attribute: "mortgage_preapproval_amount", history_id: "852ce960-clean" })
{
  "found": true, "subject": "the user", "attribute": "mortgage_preapproval_amount",
  "current": [
    { "value": "$425,000", "event_time": 1787050447, "struck": false, "citation": { "session_id": "user-correction", "turn_index": -1, "claim_id": 1675875085541886 } },
    { "value": "$400,000", "event_time": 1701304560, "struck": true,  "citation": { "session_id": "answer_3a6f1e82_2", "turn_index": 0, "claim_id": 6423372368317097 } },
    { "value": "$350,000", "event_time": 1691712060, "struck": true,  "citation": { "session_id": "answer_3a6f1e82_1", "turn_index": 2, "claim_id": 6341458025447090 } }
  ],
  "disputed": false, "contested": false, "chain_len": 3, "truncated": false,
  "revisions": [
    {
      "relation": "SUPERSEDES", "rationale": "user correction supersedes the current head claim", "ingest_time": 1787050447,
      "newer": { "value": "$425,000", "struck": false, "citation": { "session_id": "user-correction", "turn_index": -1 } },
      "older": { "value": "$400,000", "struck": true,  "citation": { "session_id": "answer_3a6f1e82_2", "turn_index": 0 } }
    },
    {
      "relation": "SUPERSEDES", "rationale": "later statement supersedes earlier (temporal rule)", "ingest_time": 1786900426,
      "newer": { "value": "$400,000", "struck": false, "citation": { "session_id": "answer_3a6f1e82_2", "turn_index": 0 } },
      "older": { "value": "$350,000", "struck": true,  "citation": { "session_id": "answer_3a6f1e82_1", "turn_index": 2 } }
    }
  ]
}
```

Three claims, two revision hops, `struck: true` on everything the current belief displaced (directly
or transitively) — `$350,000` never stopped existing, it is exactly as retrievable now as it was before
the correction, just no longer the head. Nothing was mutated, nothing was deleted.

## 5. Agent re-asks — new value, and the API's honest edge case around "the new citation"

```jsonc
// memory_ask({ question: "What was the amount I was pre-approved for when I got my mortgage from Wells Fargo?", history_id: "852ce960-clean" })
{
  "abstained": false,
  "answer": "$425,000",
  "confidence": 0.5995535804897605,
  "claim_confidence": 0.99,
  "citations": [
    { "session_id": "answer_3a6f1e82_1", "turn_index": 2, "span": "pre-approved for $350,000 from Wells Fargo.", "claim_id": 6341458025447090 },
    { "session_id": "answer_3a6f1e82_2", "turn_index": 0, "span": "pre-approved for $400,000 from Wells Fargo?", "claim_id": 6423372368317097 },
    { "session_id": "answer_3a6f1e82_2", "turn_index": 0, "span": "I got pre-approved for $400,000 from Wells Fargo", "claim_id": 3283595309687236 }
  ],
  "superseded": [
    { "value": "$400,000", "citation": { "session_id": "answer_3a6f1e82_2", "turn_index": 0, "claim_id": 6423372368317097 } },
    { "value": "$350,000", "citation": { "session_id": "answer_3a6f1e82_1", "turn_index": 2, "claim_id": 6341458025447090 } }
  ]
}
```

The answer text correctly picks up the correction (`$425,000`, `claim_confidence` now `0.99` — a
user-filed correction's own confidence per `@errata/ingest`'s `buildCorrection`). Worth stating
plainly rather than glossing over: the `citations` array here is `apps/api`'s top-3 **lexically
ranked** material claims (`apps/api/src/query.ts`, `window.slice(0, 3)`), and the new correction's
evidence span ("corrected by the user to $425,000") scores lower on token overlap against the question
than the two original spans, which literally contain "pre-approved... from Wells Fargo" — so it does
not make the top 3 here even though it is what the LLM actually answered from. `superseded` does
correctly list both prior values. The new claim's own citation is not lost — `memory_history` (§4
above) and `memory_correct`'s own return value both carry it — but a caller relying solely on
`memory_ask`'s `citations` field for "which turn produced this exact answer" would, on this particular
question's phrasing, see the older spans first. That is a property of `apps/api`'s relevance ranking,
not something this MCP layer papers over or fabricates around.

---

**Recap of what changed on the live graph:** one claim (`$425,000`, id `1675875085541886`) and one
SUPERSEDES edge, appended to `852ce960-clean`. Nothing else. `852ce960` and all 150 eval-sample
histories are untouched.
