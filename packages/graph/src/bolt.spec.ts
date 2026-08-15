import { describe, it, expect } from 'vitest';
import neo4j from 'neo4j-driver-lite';
import { toBoltParams, chunk, makeDriver } from './bolt.js';

describe('toBoltParams — the integer choke point (Day-0 law)', () => {
  it('wraps integer-keyed scalars as Bolt integers', () => {
    const p = toBoltParams({ entity_vid: 123, at: 1000, a0: 7, history_id: 'h', attribute: 'employer' });
    expect(neo4j.isInt(p.entity_vid)).toBe(true);
    expect(neo4j.isInt(p.at)).toBe(true);
    expect(neo4j.isInt(p.a0)).toBe(true);
    expect(p.history_id).toBe('h'); // strings untouched
    expect(p.attribute).toBe('employer');
  });

  it('wraps integer fields inside row maps but leaves confidence (float) as a number', () => {
    const p = toBoltParams({
      rows: [{ id: 5, src: 1, dst: 2, event_time: 100, ingest_time: 200, confidence: 0.82, key: 'k', salient: true }],
    });
    const row = (p.rows as Record<string, unknown>[])[0]!;
    expect(neo4j.isInt(row.id)).toBe(true);
    expect(neo4j.isInt(row.src)).toBe(true);
    expect(neo4j.isInt(row.event_time)).toBe(true);
    expect(neo4j.isInt(row.confidence)).toBe(false); // float stays a JS number
    expect(row.confidence).toBe(0.82);
    expect(row.key).toBe('k');
    expect(row.salient).toBe(true);
  });

  it('leaves string arrays (anchor_keys) alone', () => {
    const p = toBoltParams({ anchor_keys: ['k1', 'k2'] });
    expect(p.anchor_keys).toEqual(['k1', 'k2']);
  });

  it('throws when an integer key receives a non-integer', () => {
    expect(() => toBoltParams({ at: 1.5 })).toThrow(/non-integer/);
  });

  it('chunk splits rows into ≤1024 batches', () => {
    const rows = Array.from({ length: 2100 }, (_, i) => i);
    const parts = chunk(rows);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toHaveLength(1024);
    expect(parts[2]).toHaveLength(2100 - 2048);
  });

  it('makeDriver refuses neo4j:// URLs', () => {
    expect(() => makeDriver({ url: 'neo4j://127.0.0.1:7687', token: 't' })).toThrow(/bolt:\/\//);
  });
});
