# `@errata/mcp` — Errata as an MCP memory server

An [MCP](https://modelcontextprotocol.io) stdio server that puts Errata's append-only bitemporal
belief graph behind four tools any MCP-capable agent can mount as memory. It talks to
[`apps/api`](../../apps/api) over HTTP only — same boundary discipline as `eval/` — and makes no LLM
calls of its own; all retrieval, synthesis and calibration happen server-side in `apps/api`.

## Tools

| tool | what it does |
|---|---|
| `memory_ask` | Ask the memory a question. Returns the belief with its citation (`session_id` + `turn_index`), confidence/evidence score, any superseded prior values, and the hand-written Cypher `apps/api` executed — or a calibrated abstention with nearest-miss citations. Abstention is a structured result, never an error. |
| `memory_remember` | Record a new observation as a claim: `(subject, attribute, value)`. Supersedes the current belief if one exists; if this history has never held any claim about that (subject, attribute), the write is rejected with a structured reason instead of silently failing. |
| `memory_correct` | Record a correction, optionally naming the exact `claim_id` it supersedes. Appends a claim + a SUPERSEDES revision edge; the displaced claim keeps its id, value and citation — nothing is mutated or deleted. Returns the resulting revision chain. |
| `memory_history` | The revision chain for a `(subject, attribute)`: every claim that ever held, with `event_time` and citation, current values unstruck and every superseded value struck alongside what displaced it. |

**Not implemented here: the as-of view.** `apps/api`'s `GET /api/belief` takes `at` + `axis` and will
fold the belief as it stood at time *t* (AGENTS.md: "As-of: belief at time t via edge-time filter +
deterministic fold in app code"). This server never sends either parameter, so `memory_history`
returns the whole chain and `memory_ask` always answers as of now. `from`/`to` on `memory_history`
bound the `GET /api/diff` revision window — they do not rewind the belief.

Every result that answers a question carries a citation (Errata hard rule: uncited answers are bugs).
See [`docs/mcp-demo.md`](../../docs/mcp-demo.md) for a real, captured transcript of all four tools
against the live demo history, including the flagship `$350,000 → $400,000 → $425,000` mortgage
supersession.

### A note on `memory_remember` vs `memory_correct`

`apps/api`'s only mutating route is `POST /api/correction` (its own banner comment: "the ONLY
mutating route in this API"). It can append a new claim only when the target `(subject, attribute)`
already has at least one claim to attach a SUPERSEDES edge to — first-ever facts about something a
history has never mentioned are the offline, LLM-backed ingest pipeline's job
(`packages/ingest`), which this server deliberately never calls (no LLM calls of its own — see
"Design constraint" below). Both tools call the same endpoint under the hood: `memory_remember` is
the simple form (just supersede the current head, or report the gap); `memory_correct` additionally
accepts an explicit `supersedes_claim_id` and returns the full revision chain in one round trip.

## Configuration

| env var | default | meaning |
|---|---|---|
| `ERRATA_API_URL` | `http://127.0.0.1:8787` | Base URL of a running `apps/api` (matches its own default bind, `apps/api/src/index.ts`). |

## Run it

```sh
pnpm install               # workspace root
pnpm typecheck              # tsc -b builds dist/ for every package, including this one
node packages/mcp/dist/index.js
```

(There is no separate build script — this repo's convention is `tsc -b` project references at the
root; see `package.json`'s `typecheck` script.)

### Mount it in Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "errata": {
      "command": "node",
      "args": ["/absolute/path/to/errata/packages/mcp/dist/index.js"],
      "env": {
        "ERRATA_API_URL": "http://127.0.0.1:8787"
      }
    }
  }
}
```

`apps/api` (and `docker compose up` for HydraDB + MinIO) must already be running — see the root
`README.md` / `CLAUDE.md` quickstart.

## Design constraint: no LLM calls here

This server never calls an LLM directly. `memory_ask` hits `POST /api/ask`, which does its own
retrieval + synthesis server-side (`apps/api/src/query.ts`); `memory_remember`/`memory_correct` hit
`POST /api/correction`, a pure graph write; `memory_history` hits `GET /api/belief` + `GET /api/diff`,
both pure reads. That keeps this package small, keeps every LLM call behind `packages/llm`'s ledger
(CLAUDE.md hard rule 6), and keeps `pnpm test` here fast and network-free.

## Tests

```sh
pnpm vitest run packages/mcp     # or: pnpm test (repo-wide)
```

(There is no per-package `test` script — vitest is configured once at the root
(`vitest.config.ts`), so `pnpm --filter @errata/mcp test` is a silent no-op, not a test run.)

Unit tests cover the pure parts only — input schemas (`src/schemas.spec.ts`), response shaping
(`src/shape.spec.ts`, using fixtures captured from the real API), and the HTTP client against a
stubbed `fetch` (`src/client.spec.ts`). No live server, no LLM call, in any of them.

`scripts/demo.mjs` is not a test — it is a real MCP client that drives the built server over stdio
against a live stack, used to capture `docs/mcp-demo.md`. It appends one claim to whatever history you
point it at (`ERRATA_DEMO_HISTORY`, default `852ce960-clean`) — append-only, safe to re-run, but not
something `pnpm test` runs automatically.
