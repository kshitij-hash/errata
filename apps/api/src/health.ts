// apps/api/src/health.ts — per-history node counts for GET /api/meta/health.
//
// Read-only, admin class, never on the ask path.
//
// The counts used to be five `countLabel` label scans. At the full-corpus store size the engine
// refused them outright — `cypher_vertex_label_index_candidates rejected by admission control:
// actual 250001 exceeds limit 250000` — because a label scan's candidate set is the whole LABEL,
// not the history-filtered subset the WHERE clause asks for. The deployed demo's health route
// returned 503 while the demo itself was perfectly healthy, since /api/ask is id-anchored and
// never scans. Bounding the scan does not help: with a LIMIT the same reads time out at 30 s.
//
// So the counts are derived the way every other read in Errata is — from ids:
//
//   1. Speakers are two minted ids. That read is also the READINESS probe: it is the cheapest
//      thing this route can ask the graph (~10 ms), and it is the only failure that still 503s.
//   2. Session ids are a pure function of (history_id, ordinal), so ordinals are probed in blocks
//      until a block comes back short. Sessions are contiguous from 0, so a short block is the end.
//   3. Turns come from each Session's own `turn_count` property: exact, and no Turn read at all
//      (the Turn label is the one that broke first — 250K+ nodes).
// Those three are single-hop id reads and are always taken. The other two are traversals and are
// OPT-IN (`?counts=deep`):
//
//   4. Entities are the distinct ids reachable Session→Turn→Claim→Entity from those anchors.
//   5. Claims are the distinct ids ABOUT those entities. Anchoring on the entity rather than on
//      the turn is deliberate: a user correction is ABOUT its subject but is STATED_IN no turn, so
//      a turn-anchored count would miss exactly the claims the demo creates.
//
// Opt-in, because measured live: that traversal costs ~250 ms on the demo history and exceeds the
// engine's 30 s query timeout on a heavier one, and an abandoned query keeps burning server-side
// after the route stops waiting — so a health POLL that took it would slowly starve the store it
// is reporting on. The default answer says `skipped_at_scale` for both, which is a true statement
// about a count nobody asked for, and `?counts=deep` takes them for an admin who did.
//
// Two disciplines keep the rest honest. Every count past the readiness probe is wrapped so a
// refusal degrades to SKIPPED instead of failing the request — a health route that 503s because a
// count got expensive is worse than one that says the count was skipped. And the sequence runs
// against a wall-clock BUDGET, because "not 503" is not enough: a 30 s health check is
// indistinguishable from a dead one to whatever is polling it.
import {
  chunk,
  claimIdsForEntities,
  entityIdsForSessions,
  keys,
  nodesByIds,
  PROBE_ARM_MAX,
  vid,
} from '@errata/graph';
import type { Stmt } from '@errata/graph';

/** A count that could not be taken inside the budget. Reported instead of failing the route. */
export const SKIPPED = 'skipped_at_scale';
export type CountValue = number | typeof SKIPPED;

/** Wall-clock budget for the counts after the readiness probe. Generous enough to absorb a cold
 *  query-plan compile (measured at ~20 s only on a statement text the engine has never seen, then
 *  ~250 ms warm), tight enough that the route always answers. */
export const COUNT_BUDGET_MS = 8_000;

/** Ordinals probed per statement, and the ceiling on how many blocks we will walk. 8 blocks is
 *  512 sessions — an order of magnitude past the longest LongMemEval history (~50). */
const SESSION_BLOCK = PROBE_ARM_MAX;
const MAX_SESSION_BLOCKS = 8;

export interface GraphReader {
  read(stmt: Stmt): Promise<Record<string, unknown>[]>;
}

export interface HistoryCounts {
  counts: Record<string, CountValue>;
  /** true when every count was taken; false when at least one is SKIPPED. */
  complete: boolean;
}

export interface CountOptions {
  /** take the Entity/Claim traversals too. Off by default — see the header comment. */
  deep?: boolean;
  budgetMs?: number;
}

/** Reject if `work` outlives the deadline. The query keeps running server-side — nothing here can
 *  cancel it — but the ROUTE stops waiting, which is the property being bought. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('health: count budget exhausted')), ms);
    timer.unref?.();
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Take a count, or report SKIPPED: on a refusal, a timeout, or an already-spent budget. */
async function guarded(deadline: number, take: () => Promise<number>): Promise<CountValue> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return SKIPPED;
  try {
    return await withDeadline(take(), remaining);
  } catch {
    // Admission control, a query timeout, or our own budget. None of them is an outage.
    return SKIPPED;
  }
}

/** Walk session ordinals in id-pinned blocks until one comes back short. */
async function probeSessions(
  db: GraphReader,
  historyId: string,
): Promise<{ sessionVids: number[]; turns: number }> {
  const sessionVids: number[] = [];
  let turns = 0;
  for (let block = 0; block < MAX_SESSION_BLOCKS; block++) {
    const ids = Array.from({ length: SESSION_BLOCK }, (_, i) =>
      vid(keys.session(historyId, block * SESSION_BLOCK + i)),
    );
    const rows = await db.read(nodesByIds('Session', ids, ['turn_count']));
    for (const row of rows) {
      sessionVids.push(Number(row.id));
      turns += Number(row.turn_count ?? 0);
    }
    if (rows.length < SESSION_BLOCK) break; // a short block is the last one
  }
  return { sessionVids, turns };
}

/** Distinct ids returned by one query per chunk of anchors. UNION dedupes within a statement; the
 *  Set dedupes across them, so chunking is exact rather than approximate. */
async function distinctIds(
  db: GraphReader,
  anchors: number[],
  build: (chunkAnchors: number[]) => Stmt,
): Promise<Set<number>> {
  const seen = new Set<number>();
  for (const part of chunk(anchors, PROBE_ARM_MAX)) {
    for (const row of await db.read(build(part))) seen.add(Number(row.id));
  }
  return seen;
}

/**
 * Per-history node counts, id-anchored and budgeted.
 *
 * Throws only if the two-id Speaker probe fails — that one IS the readiness signal, and a graph
 * that cannot answer it is genuinely unreachable. Every other count degrades to SKIPPED.
 */
export async function historyCounts(
  db: GraphReader,
  historyId: string,
  { deep = false, budgetMs = COUNT_BUDGET_MS }: CountOptions = {},
): Promise<HistoryCounts> {
  const speakerVids = (['user', 'assistant'] as const).map((role) =>
    vid(keys.speaker(historyId, role)),
  );
  const speakers = await db.read(nodesByIds('Speaker', speakerVids));
  const deadline = Date.now() + budgetMs;

  const counts: Record<string, CountValue> = { Speaker: speakers.length };
  let sessionVids: number[] = [];
  counts.Session = await guarded(deadline, async () => {
    const probe = await probeSessions(db, historyId);
    sessionVids = probe.sessionVids;
    counts.Turn = probe.turns;
    return probe.sessionVids.length;
  });
  if (counts.Session === SKIPPED) counts.Turn = SKIPPED;

  if (!deep) {
    counts.Entity = SKIPPED;
    counts.Claim = SKIPPED;
    return { counts, complete: false };
  }

  let entityVids: number[] = [];
  counts.Entity =
    sessionVids.length === 0
      ? counts.Session === SKIPPED
        ? SKIPPED
        : 0
      : await guarded(deadline, async () => {
          entityVids = [...(await distinctIds(db, sessionVids, entityIdsForSessions))];
          return entityVids.length;
        });

  counts.Claim =
    entityVids.length === 0
      ? counts.Entity === SKIPPED
        ? SKIPPED
        : 0
      : await guarded(deadline, async () => {
          const claims = await distinctIds(db, entityVids, (part) =>
            claimIdsForEntities(part, historyId),
          );
          return claims.size;
        });

  return { counts, complete: !Object.values(counts).includes(SKIPPED) };
}
