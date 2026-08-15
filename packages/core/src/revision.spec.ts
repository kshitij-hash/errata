import { describe, it, expect } from 'vitest';
import { resolveBelief } from './revision.js';
import { makeClaim, makeEdge, seededShuffle } from './testkit.js';

describe('resolveBelief — supersession chains (spec 31 §7 tests 11-18)', () => {
  it('11: linear chain A→B→C: head is C, chain_len 3, A and B superseded', () => {
    const A = makeClaim({ claim_id: 1, value: 'Acme', event_time: 100 });
    const B = makeClaim({ claim_id: 2, value: 'Beta', event_time: 200 });
    const C = makeClaim({ claim_id: 3, value: 'Ciro', event_time: 300 });
    const edges = [makeEdge({ newer_id: 3, older_id: 2 }), makeEdge({ newer_id: 2, older_id: 1 })];
    const r = resolveBelief([A, B, C], edges);
    expect(r.head?.claim_id).toBe(3);
    expect(r.chain_len).toBe(3);
    expect(r.superseded.map((s) => s.claim_id).sort((x, y) => x - y)).toEqual([1, 2]);
    expect(r.disputed).toBe(false);
  });

  it('12: appending D superseding C moves the head to D and leaves a list', () => {
    const claims = [1, 2, 3, 4].map((id) => makeClaim({ claim_id: id, value: `v${id}`, event_time: id * 100 }));
    const edges = [
      makeEdge({ newer_id: 4, older_id: 3 }),
      makeEdge({ newer_id: 3, older_id: 2 }),
      makeEdge({ newer_id: 2, older_id: 1 }),
    ];
    const r = resolveBelief(claims, edges);
    expect(r.head?.claim_id).toBe(4);
    expect(r.chain_len).toBe(4);
    expect(r.superseded.map((s) => s.claim_id).sort((x, y) => x - y)).toEqual([1, 2, 3]);
  });

  it('13: a SUPERSEDES edge at a non-head is reported chain_repaired; head is the newest candidate', () => {
    const A = makeClaim({ claim_id: 1, value: 'A', event_time: 100 });
    const B = makeClaim({ claim_id: 2, value: 'B', event_time: 200 });
    const C = makeClaim({ claim_id: 3, value: 'C', event_time: 300 });
    const X = makeClaim({ claim_id: 5, value: 'X', event_time: 500 });
    const edges = [
      makeEdge({ newer_id: 3, older_id: 2 }),
      makeEdge({ newer_id: 2, older_id: 1 }),
      makeEdge({ newer_id: 5, older_id: 2 }), // X supersedes B (not the head C)
    ];
    const r = resolveBelief([A, B, C, X], edges);
    expect(r.head?.claim_id).toBe(5);
    expect(r.chain_repaired).toBe(true);
    expect(r.superseded.map((s) => s.claim_id)).toContain(3);
  });

  it('14: SUPPORTS never changes the head; it raises corroboration', () => {
    const H = makeClaim({ claim_id: 1, value: 'H', event_time: 100 });
    const S1 = makeClaim({ claim_id: 2, value: 'H', event_time: 150 });
    const S2 = makeClaim({ claim_id: 3, value: 'H', event_time: 160 });
    const edges = [
      makeEdge({ newer_id: 2, older_id: 1, relation: 'SUPPORTS' }),
      makeEdge({ newer_id: 3, older_id: 1, relation: 'SUPPORTS' }),
    ];
    const r = resolveBelief([H, S1, S2], edges);
    expect(r.head?.claim_id).toBe(1);
    expect(r.head?.corroboration).toBe(3); // origin + 2 supporters
    expect(r.superseded).toHaveLength(0);
  });

  it('15: MULTI attribute with three AFFIRM values → three coexisting beliefs', () => {
    const claims = ['chess', 'hiking', 'piano'].map((v, i) =>
      makeClaim({ claim_id: i + 1, value: v, attribute: 'hobby', arity: 'MULTI', event_time: 100 + i }),
    );
    const r = resolveBelief(claims, []);
    expect(r.heads).toHaveLength(3);
    expect(r.head).toBeNull();
    expect(r.superseded).toHaveLength(0);
    expect(r.disputed).toBe(false);
  });

  it('16: MULTI attribute with a NEGATE claim matching one member supersedes only that member', () => {
    const chess = makeClaim({ claim_id: 1, value: 'chess', attribute: 'hobby', arity: 'MULTI', event_time: 100 });
    const hiking = makeClaim({ claim_id: 2, value: 'hiking', attribute: 'hobby', arity: 'MULTI', event_time: 110 });
    const noChess = makeClaim({
      claim_id: 3,
      value: 'chess',
      attribute: 'hobby',
      arity: 'MULTI',
      polarity: 'NEGATE',
      event_time: 200,
    });
    const edges = [makeEdge({ newer_id: 3, older_id: 1, provenance: 'INFERRED' })];
    const r = resolveBelief([chess, hiking, noChess], edges);
    expect(r.heads.map((h) => h.value).sort()).toEqual(['hiking']);
    expect(r.superseded.map((s) => s.claim_id)).toContain(1);
  });

  it('17: a SUPERSEDES cycle A→B→A is broken, and a head is still returned', () => {
    const A = makeClaim({ claim_id: 1, value: 'A', event_time: 100, confidence: 0.9 });
    const B = makeClaim({ claim_id: 2, value: 'B', event_time: 200, confidence: 0.4 });
    const edges = [
      makeEdge({ newer_id: 1, older_id: 2, confidence: 0.4 }),
      makeEdge({ newer_id: 2, older_id: 1, confidence: 0.9 }),
    ];
    const r = resolveBelief([A, B], edges);
    expect(r.cycle_broken).toBe(true);
    expect(r.head).not.toBeNull();
  });

  it('18: determinism — shuffling input order 100× yields byte-identical results', () => {
    const claims = [1, 2, 3, 4].map((id) => makeClaim({ claim_id: id, value: `v${id}`, event_time: id * 100 }));
    const edges = [
      makeEdge({ newer_id: 4, older_id: 3 }),
      makeEdge({ newer_id: 3, older_id: 2 }),
      makeEdge({ newer_id: 2, older_id: 1 }),
    ];
    const canonical = JSON.stringify(resolveBelief(claims, edges));
    for (let seed = 1; seed <= 100; seed++) {
      const got = JSON.stringify(resolveBelief(seededShuffle(claims, seed), seededShuffle(edges, seed * 7)));
      expect(got).toBe(canonical);
    }
  });
});
