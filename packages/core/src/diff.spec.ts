import { describe, it, expect } from 'vitest';
import { diffChain } from './revision.js';
import { makeClaim, makeEdge } from './testkit.js';

describe('diffChain (spec 31 §7 tests 30-31)', () => {
  const A = makeClaim({ claim_id: 1, value: 'A', event_time: 100, session_id: 's1', turn_id: 's1:t0' });
  const B = makeClaim({ claim_id: 2, value: 'B', event_time: 200, session_id: 's2', turn_id: 's2:t1' });
  const C = makeClaim({ claim_id: 3, value: 'C', event_time: 300, session_id: 's3', turn_id: 's3:t2' });
  const D = makeClaim({ claim_id: 4, value: 'D', event_time: 400, session_id: 's4', turn_id: 's4:t3' });
  const edges = [
    makeEdge({ newer_id: 4, older_id: 3, ingest_time: 400 }),
    makeEdge({ newer_id: 3, older_id: 2, ingest_time: 300 }),
    makeEdge({ newer_id: 2, older_id: 1, ingest_time: 200 }),
  ];
  const claims = [A, B, C, D];

  it('30: a 4-link chain returns 3 revisions, newest-first, with both citations', () => {
    const r = diffChain(claims, edges, 100, 400);
    expect(r.from_belief?.claim_id).toBe(1);
    expect(r.to_belief?.claim_id).toBe(4);
    expect(r.revisions.map((rev) => [rev.newer.claim_id, rev.older.claim_id])).toEqual([
      [4, 3],
      [3, 2],
      [2, 1],
    ]);
    for (const rev of r.revisions) {
      expect(rev.citations.newer.session_id).toBeTruthy();
      expect(rev.citations.older.session_id).toBeTruthy();
    }
    expect(r.truncated).toBe(false);
  });

  it('31: empty diff when nothing changed between from and to', () => {
    const r = diffChain(claims, edges, 400, 400);
    expect(r.from_belief?.claim_id).toBe(4);
    expect(r.to_belief?.claim_id).toBe(4);
    expect(r.revisions).toHaveLength(0);
  });
});
