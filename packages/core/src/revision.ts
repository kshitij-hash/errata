// packages/core/src/revision.ts — head-of-chain resolution, as-of, and diff.
//
// The OpenCypher subset cannot express "a claim with no incoming SUPERSEDES", cannot do min/max,
// and has no expressions in RETURN, so ALL of head selection, tie-breaking, cycle-breaking, and
// dispute detection happen here as a pure, deterministic fold over rows the graph returned
// (spec 31 §4.3, §4.10, ADR-12). No I/O, no LLM, no database.

import type {
  BeliefResult,
  BeliefValue,
  ClaimRow,
  DiffResult,
  Relation,
  Revision,
  RevisionEdgeRow,
  TimeAxis,
} from './types.js';

const DISPUTE_EPS = 0.05;

/** Total order, newest first: (event_time desc, ingest_time desc, confidence desc, claim_id asc).
 *  claim_id asc guarantees a total order, so the same corpus always yields the same belief. */
function cmpNewestFirst(a: ClaimRow, b: ClaimRow): number {
  if (a.event_time !== b.event_time) return b.event_time - a.event_time;
  if (a.ingest_time !== b.ingest_time) return b.ingest_time - a.ingest_time;
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  return a.claim_id - b.claim_id;
}

function edgesOf(edges: RevisionEdgeRow[], rel: Relation): RevisionEdgeRow[] {
  return edges.filter((e) => e.relation === rel);
}

/** Deterministic total order over revision edges (HydraDB returns rows in no guaranteed order, and
 *  there is no ORDER BY across the reads). Applied once at fold entry so head selection, cycle
 *  breaking, and the diff chain are byte-identical across runs. */
function sortEdges(edges: RevisionEdgeRow[]): RevisionEdgeRow[] {
  return edges
    .slice()
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        b.ingest_time - a.ingest_time ||
        a.older_id - b.older_id ||
        a.newer_id - b.newer_id,
    );
}

/** distinct turns citing a claim = 1 (origin) + distinct SUPPORTS newer-ids targeting it. */
function corroborationMap(edges: RevisionEdgeRow[]): Map<number, number> {
  const byTarget = new Map<number, Set<number>>();
  for (const e of edgesOf(edges, 'SUPPORTS')) {
    let s = byTarget.get(e.older_id);
    if (!s) byTarget.set(e.older_id, (s = new Set()));
    s.add(e.newer_id);
  }
  const out = new Map<number, number>();
  for (const [target, supporters] of byTarget) out.set(target, 1 + supporters.size);
  return out;
}

function toBeliefValue(c: ClaimRow, corroboration: number): BeliefValue {
  return {
    claim_id: c.claim_id,
    value: c.value,
    value_norm: c.value_norm,
    attribute: c.attribute,
    event_time: c.event_time,
    ingest_time: c.ingest_time,
    confidence: c.confidence,
    provenance: c.provenance,
    judge_status: c.judge_status,
    citation: { session_id: c.session_id, turn_index: c.turn_index, claim_id: c.claim_id },
    evidence_span: c.evidence_span,
    corroboration,
  };
}

/** Find one SUPERSEDES edge to drop to break a cycle (the lowest-confidence edge on the cycle),
 *  or null if the SUPERSEDES graph is acyclic. Chains are short; DFS is fine. */
function cycleEdgeToDrop(sup: RevisionEdgeRow[]): RevisionEdgeRow | null {
  const adj = new Map<number, RevisionEdgeRow[]>();
  for (const e of sup) {
    let a = adj.get(e.newer_id);
    if (!a) adj.set(e.newer_id, (a = []));
    a.push(e);
  }
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<number, number>();
  const stackEdges: RevisionEdgeRow[] = [];

  function visit(node: number): RevisionEdgeRow | null {
    color.set(node, GRAY);
    for (const e of adj.get(node) ?? []) {
      const cNext = color.get(e.older_id) ?? WHITE;
      if (cNext === GRAY) {
        // back-edge → cycle. Collect edges on the current path from e.older_id, plus e.
        const cycle: RevisionEdgeRow[] = [e];
        for (let i = stackEdges.length - 1; i >= 0; i--) {
          cycle.push(stackEdges[i]!);
          if (stackEdges[i]!.newer_id === e.older_id) break;
        }
        return cycle.reduce((lo, x) => (x.confidence < lo.confidence ? x : lo), cycle[0]!);
      }
      if (cNext === WHITE) {
        stackEdges.push(e);
        const found = visit(e.older_id);
        stackEdges.pop();
        if (found) return found;
      }
    }
    color.set(node, BLACK);
    return null;
  }

  for (const node of adj.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}

/** claims transitively reachable from `startId` following SUPERSEDES newer→older (inclusive). */
function chainFrom(startId: number, sup: RevisionEdgeRow[]): Set<number> {
  const adj = new Map<number, number[]>();
  for (const e of sup) {
    let a = adj.get(e.newer_id);
    if (!a) adj.set(e.newer_id, (a = []));
    a.push(e.older_id);
  }
  const seen = new Set<number>([startId]);
  const stack = [startId];
  while (stack.length) {
    const n = stack.pop()!;
    for (const older of adj.get(n) ?? []) {
      if (!seen.has(older)) {
        seen.add(older);
        stack.push(older);
      }
    }
  }
  return seen;
}

function emptyResult(): BeliefResult {
  return {
    head: null,
    heads: [],
    superseded: [],
    disputed: false,
    contested: false,
    chain_len: 0,
    cycle_broken: false,
    chain_repaired: false,
  };
}

function resolveFunctional(claims: ClaimRow[], edges: RevisionEdgeRow[]): BeliefResult {
  if (claims.length === 0) return emptyResult();
  const corr = corroborationMap(edges);
  const bv = (c: ClaimRow): BeliefValue => toBeliefValue(c, corr.get(c.claim_id) ?? 1);

  // 1) break SUPERSEDES cycles by dropping the lowest-confidence edge, until acyclic.
  let sup = edgesOf(edges, 'SUPERSEDES').slice();
  let cycle_broken = false;
  for (let guard = 0; guard < sup.length + 1; guard++) {
    const drop = cycleEdgeToDrop(sup);
    if (!drop) break;
    sup = sup.filter((e) => e !== drop);
    cycle_broken = true;
  }

  const byId = new Map(claims.map((c) => [c.claim_id, c]));
  const displaced = new Set(sup.map((e) => e.older_id));
  // a claim that SUPPORTS another defers to it — it corroborates, it does not compete as a head.
  const supporters = new Set(edgesOf(edges, 'SUPPORTS').map((e) => e.newer_id));
  let candidates = claims
    .filter((c) => !displaced.has(c.claim_id) && !supporters.has(c.claim_id))
    .sort(cmpNewestFirst);
  // fallback: never return an empty belief — if constraints eliminated everyone, take the newest.
  if (candidates.length === 0) candidates = claims.slice().sort(cmpNewestFirst);

  // 2) head = newest non-displaced, non-supporting claim.
  const head = candidates[0]!;

  // 3) dispute cluster: candidates CONTRADICTS-linked to the head within eps of its confidence.
  const contra = edgesOf(edges, 'CONTRADICTS');
  const neighborsOf = (id: number): number[] =>
    contra.filter((e) => e.newer_id === id || e.older_id === id).map((e) => (e.newer_id === id ? e.older_id : e.newer_id));
  const cluster = new Set<number>([head.claim_id]);
  const queue = [head.claim_id];
  while (queue.length) {
    const id = queue.pop()!;
    for (const nb of neighborsOf(id)) {
      const c = byId.get(nb);
      if (!c || cluster.has(nb) || displaced.has(nb) || supporters.has(nb)) continue;
      if (Math.abs(c.confidence - head.confidence) <= DISPUTE_EPS) {
        cluster.add(nb);
        queue.push(nb);
      }
    }
  }
  const disputed = cluster.size > 1;

  // 4) contested: head touched by ANY CONTRADICTS edge (even a lone low-confidence one) that is
  //    not part of the resolved dispute — caps answer confidence downstream (spec 31 §7 test 22).
  const contested = contra.some((e) => e.newer_id === head.claim_id || e.older_id === head.claim_id);

  const headIds = disputed
    ? [...cluster].map((id) => byId.get(id)!).sort(cmpNewestFirst)
    : [head];
  const headSet = new Set(headIds.map((c) => c.claim_id));

  // 5) chain_repaired: extra non-displaced candidates that are neither head nor disputed peers
  //    (a SUPERSEDES edge pointed at a non-head, leaving an orphan). Folded into superseded.
  const chain_repaired = candidates.some((c) => !headSet.has(c.claim_id));

  const superseded = claims
    .filter((c) => !headSet.has(c.claim_id) && !supporters.has(c.claim_id))
    .sort(cmpNewestFirst)
    .map(bv);
  const chain_len = chainFrom(head.claim_id, sup).size;

  return {
    head: disputed ? null : bv(head),
    heads: headIds.map(bv),
    superseded,
    disputed,
    contested,
    chain_len,
    cycle_broken,
    chain_repaired,
  };
}

function resolveMulti(claims: ClaimRow[], edges: RevisionEdgeRow[]): BeliefResult {
  if (claims.length === 0) return emptyResult();
  const corr = corroborationMap(edges);
  const bv = (c: ClaimRow): BeliefValue => toBeliefValue(c, corr.get(c.claim_id) ?? 1);
  const displaced = new Set(edgesOf(edges, 'SUPERSEDES').map((e) => e.older_id));
  const supporters = new Set(edgesOf(edges, 'SUPPORTS').map((e) => e.newer_id));
  // members coexist; a NEGATE claim is a negation, not a displayable value; a supporter corroborates.
  const heads = claims
    .filter(
      (c) => c.polarity !== 'NEGATE' && !displaced.has(c.claim_id) && !supporters.has(c.claim_id),
    )
    .sort(cmpNewestFirst);
  const superseded = claims.filter((c) => displaced.has(c.claim_id)).sort(cmpNewestFirst);
  return {
    head: null,
    heads: heads.map(bv),
    superseded: superseded.map(bv),
    disputed: false,
    contested: false,
    chain_len: heads.length,
    cycle_broken: false,
    chain_repaired: false,
  };
}

/** Resolve the current belief for one (subject, attribute) from its claims + revision edges. */
export function resolveBelief(claims: ClaimRow[], edges: RevisionEdgeRow[]): BeliefResult {
  if (claims.length === 0) return emptyResult();
  const sorted = sortEdges(edges);
  const arity = claims[0]!.arity; // all claims for one attribute share arity
  return arity === 'FUNCTIONAL' ? resolveFunctional(claims, sorted) : resolveMulti(claims, sorted);
}

/** Belief at time `t`: filter server-side rows, then run the SAME fold (spec 31 §4.4, C5).
 *  Nothing is rewritten and no snapshot is rebuilt. */
export function resolveAsOf(
  claims: ClaimRow[],
  edges: RevisionEdgeRow[],
  at: number,
  axis: TimeAxis = 'event',
): BeliefResult {
  const claimsAt = claims.filter((c) =>
    axis === 'event' ? c.event_time > -1 && c.event_time <= at : c.ingest_time <= at,
  );
  // supersessions learned after `t` do not apply — filter revision edges by ingest_time.
  const edgesAt = edges.filter((e) => e.ingest_time <= at);
  return resolveBelief(claimsAt, edgesAt);
}

/** The revision chain between the belief at `from` and at `to` (newest-first). */
export function diffChain(
  claims: ClaimRow[],
  edges: RevisionEdgeRow[],
  from: number,
  to: number,
): DiffResult {
  const fromBelief = resolveAsOf(claims, edges, from, 'event').head;
  const toBelief = resolveAsOf(claims, edges, to, 'event').head;
  if (!toBelief) return { from_belief: fromBelief, to_belief: toBelief, revisions: [], truncated: false };

  const byId = new Map(claims.map((c) => [c.claim_id, c]));
  const sup = sortEdges(edgesOf(edges, 'SUPERSEDES'));
  // walk from the `to` head down its SUPERSEDES chain, stopping at the `from` head.
  // deterministic linked-list: the highest-confidence edge per newer head wins (first after sort).
  const supByNewer = new Map<number, RevisionEdgeRow>();
  for (const e of sup) if (!supByNewer.has(e.newer_id)) supByNewer.set(e.newer_id, e);
  const corr = corroborationMap(edges);
  const bv = (c: ClaimRow): BeliefValue => toBeliefValue(c, corr.get(c.claim_id) ?? 1);

  const revisions: Revision[] = [];
  const MAX = 8; // spec 31 §4.5 — a chain longer than 8 is itself a finding
  let cursor: number | undefined = toBelief.claim_id;
  let truncated = false;
  const stopAt = fromBelief?.claim_id;
  const visited = new Set<number>();
  for (let hop = 0; cursor !== undefined && cursor !== stopAt; hop++) {
    if (hop >= MAX) {
      truncated = true;
      break;
    }
    if (visited.has(cursor)) break;
    visited.add(cursor);
    const e = supByNewer.get(cursor);
    if (!e) break;
    const newer = byId.get(e.newer_id);
    const older = byId.get(e.older_id);
    if (!newer || !older) break;
    revisions.push({
      newer: bv(newer),
      older: bv(older),
      relation: e.relation,
      ingest_time: e.ingest_time,
      confidence: e.confidence,
      provenance: e.provenance,
      judge_status: e.judge_status,
      rationale: e.rationale,
      citations: {
        newer: { session_id: newer.session_id, turn_index: newer.turn_index, claim_id: newer.claim_id },
        older: { session_id: older.session_id, turn_index: older.turn_index, claim_id: older.claim_id },
      },
    });
    cursor = e.older_id;
  }
  return { from_belief: fromBelief, to_belief: toBelief, revisions, truncated };
}
