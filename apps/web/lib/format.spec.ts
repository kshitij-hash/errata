import { describe, expect, it } from 'vitest';
import { DEMO_SESSIONS } from '../config/demo';
import { CORRECTION_SESSION, citeLabel, isCorrection, monthStamp, sameValue, sessionOrdinal, stamp } from './format';

describe('citation labelling', () => {
  it('labels a citation by its session ordinal, not its session_id (13 of 500 histories reuse ids)', () => {
    const first = DEMO_SESSIONS[0]!;
    expect(citeLabel(first.session_id, 3)).toBe('s1:t3');
    const last = DEMO_SESSIONS[DEMO_SESSIONS.length - 1]!;
    expect(citeLabel(last.session_id, 0)).toBe(`s${DEMO_SESSIONS.length}:t0`);
  });

  it('degrades visibly rather than silently when a session is not in the pinned history', () => {
    expect(citeLabel('not-a-session', 7)).toBe('s?:t7');
    expect(sessionOrdinal('not-a-session')).toBeNull();
  });

  it('names a correction claim by its provenance — it cites this conversation, not a transcript turn', () => {
    expect(isCorrection(CORRECTION_SESSION)).toBe(true);
    expect(citeLabel(CORRECTION_SESSION, -1)).toBe('your correction');
    expect(isCorrection('answer_3a6f1e82_2')).toBe(false);
  });

  it('numbers every session of the pinned history exactly once, in corpus order', () => {
    expect(DEMO_SESSIONS.map((s) => s.ordinal)).toEqual(DEMO_SESSIONS.map((_, i) => i));
  });
});

describe('date stamps', () => {
  it('reads epoch seconds in UTC, the axis the graph stores', () => {
    expect(stamp(1701304560)).toBe('NOV 30 2023');
    expect(monthStamp(1691712000)).toBe('Aug 2023');
  });
});

describe('predecessor de-duplication', () => {
  it('treats the two extractors’ normalisations of one amount as the same value', () => {
    expect(sameValue('400000 USD', '$400,000')).toBe(true);
    expect(sameValue('$400,000', '$400,000')).toBe(true);
  });

  it('never collapses a genuine revision', () => {
    expect(sameValue('$350,000', '$400,000')).toBe(false);
    expect(sameValue('Wells Fargo', 'Chase')).toBe(false);
  });
});
