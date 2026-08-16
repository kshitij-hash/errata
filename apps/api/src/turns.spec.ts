// /api/turns — transcript context around a citation. The assertions that matter are that the read
// is id-anchored (the window's ids are minted from the turn natural key, never filtered by
// turn_idx) and that it stays read-only.

import { describe, it, expect } from 'vitest';
import { keys, vid } from '@errata/graph';
import type { GraphClient, Stmt } from '@errata/graph';
import { ordinalFromTurnKey, turnsQuery } from './turns.js';

const HISTORY = 'demo_h';
const ORDINAL = 31;

function turnRow(idx: number, role: string, text: string) {
  const key = keys.turn(HISTORY, ORDINAL, idx);
  return {
    turn_vid: vid(key), turn_key: key, session_id: 's31', turn_id: `s31:${idx}`,
    turn_idx: idx, role, text, event_time: 1_701_304_560 + idx, event_time_iso: '2023-11-30',
  };
}
const TURNS = [0, 1, 2, 3, 4, 5].map((i) => turnRow(i, i % 2 === 0 ? 'user' : 'assistant', `turn ${i}`));

interface Stub {
  reads: Stmt[];
  client: GraphClient;
}
function stub(rows: (stmt: Stmt) => Record<string, unknown>[]): Stub {
  const reads: Stmt[] = [];
  const client = {
    async read(stmt: Stmt) {
      reads.push(stmt);
      return rows(stmt);
    },
  } as unknown as GraphClient;
  return { reads, client };
}

describe('/api/turns — id-anchored neighbour window', () => {
  it('returns the cited turn ± radius, in transcript order, with the anchor flagged', async () => {
    const s = stub((stmt) => {
      const ids = new Set(Object.values(stmt.params));
      return TURNS.filter((t) => ids.has(t.turn_vid));
    });
    const out = await turnsQuery(s.client, { historyId: HISTORY, sessionId: 's31', aroundTurn: 3, radius: 2, sessionOrdinal: ORDINAL });

    expect(out.turns.map((t) => t.turn_index)).toEqual([1, 2, 3, 4, 5]);
    expect(out.turns.filter((t) => t.anchor).map((t) => t.turn_index)).toEqual([3]);
    expect(out.turns[0]!.role).toBe('assistant');
    expect(out.turns[0]!.text).toBe('turn 1');
    expect(out.session_ordinal).toBe(ORDINAL);
    expect(out.radius).toBe(2);
  });

  it('defaults to radius 2 and clamps a negative turn window at 0', async () => {
    const s = stub((stmt) => {
      const ids = new Set(Object.values(stmt.params));
      return TURNS.filter((t) => ids.has(t.turn_vid));
    });
    const out = await turnsQuery(s.client, { historyId: HISTORY, sessionId: 's31', aroundTurn: 0, sessionOrdinal: ORDINAL });
    expect(out.radius).toBe(2);
    expect(out.turns.map((t) => t.turn_index)).toEqual([0, 1, 2]); // no -2/-1 arms
    expect(Object.keys(s.reads[0]!.params)).toEqual(['a0', 'a1', 'a2']);
  });

  it('caps an absurd radius rather than building an unbounded read', async () => {
    const s = stub(() => []);
    const out = await turnsQuery(s.client, { historyId: HISTORY, sessionId: 's31', aroundTurn: 100, radius: 500, sessionOrdinal: ORDINAL });
    expect(out.radius).toBe(7);
    expect(Object.keys(s.reads[0]!.params).length).toBeLessThanOrEqual(16);
  });

  it('is id-anchored: every arm pins a turn id minted from the turn natural key', async () => {
    const s = stub(() => []);
    await turnsQuery(s.client, { historyId: HISTORY, sessionId: 's31', aroundTurn: 3, radius: 1, sessionOrdinal: ORDINAL });
    const stmt = s.reads[0]!;
    expect(stmt.text).not.toMatch(/turn_idx\s*[<>=]/); // never a property range filter
    expect(stmt.text).not.toMatch(/\bIN\b/); // the subset has no IN
    expect(Object.values(stmt.params)).toEqual([2, 3, 4].map((i) => vid(keys.turn(HISTORY, ORDINAL, i))));
  });

  it('is read-only: no statement it issues writes', async () => {
    const s = stub(() => []);
    await turnsQuery(s.client, { historyId: HISTORY, sessionId: 's31', aroundTurn: 3, sessionOrdinal: ORDINAL });
    for (const r of s.reads) expect(r.text).not.toMatch(/\b(MERGE|CREATE|SET|DELETE|REMOVE)\b/);
  });

  it('resolves the session ordinal from a claim id when one is given (one id-anchored hop)', async () => {
    const s = stub((stmt) => {
      if (stmt.text.startsWith('MATCH (c:Claim')) return [turnRow(4, 'user', 'turn 4')];
      const ids = new Set(Object.values(stmt.params));
      return TURNS.filter((t) => ids.has(t.turn_vid));
    });
    const out = await turnsQuery(s.client, { historyId: HISTORY, sessionId: '', aroundTurn: 0, radius: 1, claimId: 12345 });
    expect(out.session_ordinal).toBe(ORDINAL);
    expect(out.around_turn).toBe(4); // taken from the claim's own turn, not the query string
    expect(out.turns.map((t) => t.turn_index)).toEqual([3, 4, 5]);
    expect(s.reads[0]!.params).toEqual({ claim_vid: 12345 });
  });

  it('falls back to a bounded Session lookup when only session_id is known', async () => {
    const s = stub((stmt) => {
      if (stmt.text.startsWith('MATCH (s:Session')) return [{ ordinal: ORDINAL, session_id: 's31' }];
      const ids = new Set(Object.values(stmt.params));
      return TURNS.filter((t) => ids.has(t.turn_vid));
    });
    const out = await turnsQuery(s.client, { historyId: HISTORY, sessionId: 's31', aroundTurn: 2, radius: 1 });
    expect(out.session_ordinal).toBe(ORDINAL);
    expect(out.turns.map((t) => t.turn_index)).toEqual([1, 2, 3]);
  });

  it('returns an empty window (never a scan) when the session cannot be resolved', async () => {
    const s = stub(() => []);
    const out = await turnsQuery(s.client, { historyId: HISTORY, sessionId: 'nope', aroundTurn: 2 });
    expect(out.turns).toEqual([]);
    expect(s.reads).toHaveLength(1); // only the failed Session lookup
  });

  it('ordinalFromTurnKey parses the documented turn natural key', () => {
    expect(ordinalFromTurnKey('h:demo_h|s:31|t:4', 'demo_h')).toBe(31);
    expect(ordinalFromTurnKey('h:other|s:31|t:4', 'demo_h')).toBeNull();
    expect(ordinalFromTurnKey('garbage', 'demo_h')).toBeNull();
  });
});
