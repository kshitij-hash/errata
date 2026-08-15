// packages/core/src/testkit.ts — typed factories for building claim/edge fixtures in specs.
// Not exported from the package barrel; compiled but unreferenced by the public surface.

import type { ClaimRow, RevisionEdgeRow } from './types.js';

let _auto = 1000;

export function makeClaim(p: Partial<ClaimRow> & { value: string }): ClaimRow {
  const value = p.value;
  return {
    claim_id: p.claim_id ?? _auto++,
    value,
    value_norm: p.value_norm ?? value.toLowerCase().trim(),
    attribute: p.attribute ?? 'employer',
    arity: p.arity ?? 'FUNCTIONAL',
    polarity: p.polarity ?? 'AFFIRM',
    event_time: p.event_time ?? 1_600_000_000,
    ingest_time: p.ingest_time ?? 1_700_000_000,
    confidence: p.confidence ?? 0.8,
    provenance: p.provenance ?? 'EXTRACTED',
    judge_status: p.judge_status ?? 'OK',
    session_id: p.session_id ?? 's1',
    turn_id: p.turn_id ?? 's1:t0',
    evidence_span: p.evidence_span ?? '',
    claim_key: p.claim_key,
  };
}

export function makeEdge(p: Partial<RevisionEdgeRow> & { newer_id: number; older_id: number }): RevisionEdgeRow {
  return {
    newer_id: p.newer_id,
    older_id: p.older_id,
    relation: p.relation ?? 'SUPERSEDES',
    ingest_time: p.ingest_time ?? 1_700_000_000,
    confidence: p.confidence ?? 0.8,
    provenance: p.provenance ?? 'INFERRED',
    judge_status: p.judge_status ?? 'OK',
    rationale: p.rationale ?? '',
  };
}

/** Fisher–Yates with a seeded LCG — deterministic shuffle for determinism tests. */
export function seededShuffle<T>(arr: readonly T[], seed: number): T[] {
  const a = arr.slice();
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (1664525 * s + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
