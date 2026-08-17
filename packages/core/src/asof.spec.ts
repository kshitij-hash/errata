import { describe, it, expect } from 'vitest';
import { resolveAsOf, resolveBelief } from './revision.js';
import { makeClaim, makeEdge } from './testkit.js';

const T_2019 = 1546300800;
const T_2020 = 1577836800;
const T_2021 = 1609459200;
const T_2023_05_07 = 1683417600;
const T_2024_01_01 = 1704067200;
const T_2025 = 1735689600;
const T_2026 = 1767225600;
const T_2027 = 1798761600;

describe('resolveAsOf — boundaries ', () => {
  it('23: at == a claim event_time includes it (inclusive <=), both axes', () => {
    const c = makeClaim({ claim_id: 1, value: 'V', event_time: T_2020, ingest_time: T_2021 });
    expect(resolveAsOf([c], [], T_2020, 'event').head?.claim_id).toBe(1);
    expect(resolveAsOf([c], [], T_2021, 'ingest').head?.claim_id).toBe(1);
  });

  it('24: at one second before the first claim → no belief', () => {
    const c = makeClaim({ claim_id: 1, value: 'V', event_time: T_2020 });
    expect(resolveAsOf([c], [], T_2020 - 1, 'event').head).toBeNull();
  });

  it('25: at between two claims returns the earlier one, later absent from superseded', () => {
    const c1 = makeClaim({ claim_id: 1, value: 'A', event_time: T_2020 });
    const c2 = makeClaim({ claim_id: 2, value: 'B', event_time: T_2025 });
    const edges = [makeEdge({ newer_id: 2, older_id: 1, ingest_time: T_2025 })];
    const r = resolveAsOf([c1, c2], edges, T_2021, 'event');
    expect(r.head?.claim_id).toBe(1);
    expect(r.superseded).toHaveLength(0);
  });

  it('26: axis divergence (#3944 shape): event known early, ingest late', () => {
    const c = makeClaim({ claim_id: 1, value: '7 May 2023', event_time: T_2023_05_07, ingest_time: T_2026 });
    expect(resolveAsOf([c], [], T_2024_01_01, 'event').head?.claim_id).toBe(1);
    expect(resolveAsOf([c], [], T_2024_01_01, 'ingest').head).toBeNull();
  });

  it('27: a retroactive claim (older event, newer ingest) never takes the head on the event axis', () => {
    const c1 = makeClaim({ claim_id: 1, value: 'V1', event_time: T_2020, ingest_time: T_2021 });
    const retro = makeClaim({ claim_id: 2, value: 'V2', event_time: T_2019, ingest_time: T_2026 });
    expect(resolveBelief([c1, retro], []).head?.claim_id).toBe(1);
    // absent on the ingest axis before it was learned…
    expect(resolveAsOf([c1, retro], [], T_2025, 'ingest').superseded.map((s) => s.claim_id)).not.toContain(2);
    // …and present (but not head) once its ingest_time has passed.
    const later = resolveAsOf([c1, retro], [], T_2027, 'ingest');
    expect(later.head?.claim_id).toBe(1);
    expect([...later.superseded.map((s) => s.claim_id), later.head?.claim_id]).toContain(2);
  });

  it('28: sentinel event_time = -1 never becomes head on the event axis and never throws', () => {
    const real = makeClaim({ claim_id: 1, value: 'real', event_time: T_2020 });
    const unknown = makeClaim({ claim_id: 2, value: 'unknown', event_time: -1 });
    expect(resolveBelief([real, unknown], []).head?.claim_id).toBe(1);
    expect(resolveAsOf([unknown], [], T_2025, 'event').head).toBeNull();
    expect(() => resolveAsOf([unknown], [], T_2025, 'event')).not.toThrow();
  });

  it('29: revision edges with ingest_time > at are excluded, so an as-of belief can be later superseded', () => {
    const c1 = makeClaim({ claim_id: 1, value: 'A', event_time: 100, ingest_time: 1000 });
    const c2 = makeClaim({ claim_id: 2, value: 'B', event_time: 200, ingest_time: 2000 });
    const edges = [makeEdge({ newer_id: 2, older_id: 1, ingest_time: 2000 })];
    expect(resolveAsOf([c1, c2], edges, 1500, 'ingest').head?.claim_id).toBe(1); // c2 not yet known
    const after = resolveAsOf([c1, c2], edges, 2500, 'ingest');
    expect(after.head?.claim_id).toBe(2);
    expect(after.superseded.map((s) => s.claim_id)).toContain(1);
  });
});
