import { describe, it, expect } from 'vitest';
import { resolveBelief } from './revision.js';
import { makeClaim, makeEdge, seededShuffle } from './testkit.js';

describe('resolveBelief — simultaneous contradictions (spec 31 §7 tests 19-22)', () => {
  it('19: two claims both CONTRADICTS the head → disputed, both returned with citations', () => {
    const H = makeClaim({ claim_id: 1, value: 'H', event_time: 300, confidence: 0.8, session_id: 's1', turn_id: 's1:t0' });
    const X = makeClaim({ claim_id: 2, value: 'X', event_time: 100, confidence: 0.8, session_id: 's2', turn_id: 's2:t3' });
    const Y = makeClaim({ claim_id: 3, value: 'Y', event_time: 200, confidence: 0.8, session_id: 's3', turn_id: 's3:t5' });
    const edges = [
      makeEdge({ newer_id: 2, older_id: 1, relation: 'CONTRADICTS' }),
      makeEdge({ newer_id: 3, older_id: 1, relation: 'CONTRADICTS' }),
    ];
    const r = resolveBelief([H, X, Y], edges);
    expect(r.disputed).toBe(true);
    expect(r.heads.length).toBeGreaterThanOrEqual(2);
    for (const h of r.heads) {
      expect(h.citation.session_id).toBeTruthy();
      expect(typeof h.citation.turn_index).toBe('number');
    }
    expect(r.head).toBeNull();
  });

  it('20: disputed heads follow the tie-break order and are stable under shuffle', () => {
    const claims = [
      makeClaim({ claim_id: 1, value: 'H', event_time: 300, confidence: 0.8 }),
      makeClaim({ claim_id: 2, value: 'X', event_time: 100, confidence: 0.8 }),
      makeClaim({ claim_id: 3, value: 'Y', event_time: 200, confidence: 0.8 }),
    ];
    const edges = [
      makeEdge({ newer_id: 2, older_id: 1, relation: 'CONTRADICTS' }),
      makeEdge({ newer_id: 3, older_id: 1, relation: 'CONTRADICTS' }),
    ];
    const canonical = JSON.stringify(resolveBelief(claims, edges).heads.map((h) => h.claim_id));
    expect(JSON.parse(canonical)).toEqual([1, 3, 2]); // newest-first by event_time
    for (let seed = 1; seed <= 30; seed++) {
      const got = resolveBelief(seededShuffle(claims, seed), seededShuffle(edges, seed)).heads.map((h) => h.claim_id);
      expect(JSON.stringify(got)).toBe(canonical);
    }
  });

  it('21: a later SUPERSEDES over a disputed pair collapses the dispute', () => {
    const H = makeClaim({ claim_id: 1, value: 'H', event_time: 300 });
    const X = makeClaim({ claim_id: 2, value: 'X', event_time: 100 });
    const Y = makeClaim({ claim_id: 3, value: 'Y', event_time: 200 });
    const Z = makeClaim({ claim_id: 4, value: 'Z', event_time: 900 });
    const edges = [
      makeEdge({ newer_id: 2, older_id: 1, relation: 'CONTRADICTS' }),
      makeEdge({ newer_id: 3, older_id: 1, relation: 'CONTRADICTS' }),
      makeEdge({ newer_id: 4, older_id: 1 }),
      makeEdge({ newer_id: 4, older_id: 2 }),
      makeEdge({ newer_id: 4, older_id: 3 }),
    ];
    const r = resolveBelief([H, X, Y, Z], edges);
    expect(r.disputed).toBe(false);
    expect(r.head?.claim_id).toBe(4);
  });

  it('22: an UNJUDGED CONTRADICTS edge participates (never dropped) and marks the head contested', () => {
    const H = makeClaim({ claim_id: 1, value: 'H', event_time: 300, confidence: 0.8 });
    const X = makeClaim({ claim_id: 2, value: 'X', event_time: 100, confidence: 0.1 });
    const edges = [
      makeEdge({ newer_id: 2, older_id: 1, relation: 'CONTRADICTS', judge_status: 'UNJUDGED', confidence: 0.1 }),
    ];
    const r = resolveBelief([H, X], edges);
    expect(r.head?.claim_id).toBe(1); // low-confidence contradictor does not win
    expect(r.disputed).toBe(false); // and is far from the head's confidence, so not a real dispute
    expect(r.contested).toBe(true); // but the contradiction is surfaced, not dropped
    expect(r.superseded.map((s) => s.claim_id)).toContain(2); // X still present
  });
});
