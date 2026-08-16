import { api } from './api';
import type { BeliefValue } from './api';

export interface ChainClaim {
  id: number;
  value: string;
  attribute: string;
  event_time: number;
  ingest_time: number;
  confidence: number;
  provenance: string;
  session_id: string;
  turn_index: number;
  span: string;
}

export interface ChainRevision {
  newerId: number;
  olderId: number;
  relation: string;
  /** the revision becomes visible when the newer claim is born */
  at: number;
}

export interface Chain {
  attribute: string;
  claims: ChainClaim[]; // ascending by event_time
  revisions: ChainRevision[];
  headId: number | null;
  /** claims the fold does not consider current — a superset of the SUPERSEDES edge targets, because
   *  the head is chosen by a deterministic fold in code, not by the edges alone (blueprint R2). */
  supersededIds: number[];
}

const toClaim = (b: BeliefValue): ChainClaim => ({
  id: b.citation.claim_id ?? -1,
  value: b.value,
  attribute: b.attribute,
  event_time: b.event_time,
  ingest_time: b.ingest_time,
  confidence: b.confidence,
  provenance: b.provenance,
  session_id: b.citation.session_id,
  turn_index: b.citation.turn_index,
  span: b.evidence_span,
});

/**
 * One (subject, attribute)'s whole revision chain, assembled from the two existing reads: /belief
 * gives every claim (head + superseded), /diff gives the revision edges between them. Both are
 * id-anchored reads on the demo path — nothing new was invented for the Timeline.
 */
export async function loadChain(subject: string, attribute: string, historyId: string): Promise<Chain> {
  const [belief, diff] = await Promise.all([
    api.belief(subject, attribute, historyId),
    api.diff(subject, attribute, historyId, 0, 2_000_000_000),
  ]);

  const byId = new Map<number, ChainClaim>();
  for (const b of [...belief.superseded, ...belief.negations, ...belief.heads]) {
    const c = toClaim(b);
    if (c.id >= 0) byId.set(c.id, c);
  }
  for (const r of diff.revisions) {
    for (const b of [r.older, r.newer]) {
      const c = toClaim(b);
      if (c.id >= 0 && !byId.has(c.id)) byId.set(c.id, c);
    }
  }

  const claims = [...byId.values()].sort((a, b) => a.event_time - b.event_time || a.id - b.id);
  const revisions: ChainRevision[] = diff.revisions
    .filter((r) => r.newer.citation.claim_id != null && r.older.citation.claim_id != null)
    .map((r) => ({
      newerId: r.newer.citation.claim_id!,
      olderId: r.older.citation.claim_id!,
      relation: r.relation,
      at: r.newer.event_time,
    }));

  return {
    attribute,
    claims,
    revisions,
    headId: belief.belief?.citation.claim_id ?? null,
    supersededIds: belief.superseded.map((s) => s.citation.claim_id).filter((id): id is number => id != null),
  };
}
