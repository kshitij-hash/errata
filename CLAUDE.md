# Errata — build conventions

Agent-memory layer on HydraDB: append-only belief graph. Claims carry event_time, ingest_time,
citation (session_id, positional turn_index), confidence, provenance EXTRACTED|INFERRED.
Contradictions append SUPERSEDES/CONTRADICTS revision edges. Nothing is ever mutated or deleted.

## Hard rules
1. Claims append-only; any mutation/deletion path is a bug.
2. No vector store in the answer path.
3. Every answer carries a citation; uncited answers are bugs.
4. Cypher is hand-written against HydraDB's deliberate OpenCypher subset. Rejected at parse
   time: undirected patterns, IN, CONTAINS, IS NULL, RETURN *, min()/max(), filtering WITH,
   unbounded *. Upsert = MERGE {id} then SET. Batches <=1024 rows via UNWIND over Bolt.
5. Vertex ids: 53-bit blake2b hash (packages/graph/ids.ts is the only place that computes them).
6. LLM calls only via packages/llm (OpenRouter); never inside vitest; every call writes the ledger.
7. pnpm only. Exact pins. No install scripts (allowBuilds empty). Never edit lockfile by hand.
8. Commits: one-line conventional, no co-author, no body.
9. Secrets in env only; .env is gitignored; there is no secret in CI.

## Layout
apps/web (Next 16, Vercel) - apps/api (Hono, pod) - packages/core (pure logic, vitest) -
packages/graph (Bolt + Cypher) - packages/llm (OpenRouter + ledger) - packages/ingest (CLI) -
eval/ (Python 3.13, uv, standalone).

## Run
docker compose up (HydraDB+MinIO, loopback-bound; RUST_MIN_STACK=33554432; never
CLOUD_PROVIDER=local for real data). pnpm dev / pnpm test / pnpm lint.
