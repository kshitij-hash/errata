// packages/core/src/temporal.spec.ts — the temporal layer is pure arithmetic, so it is tested as
// arithmetic: no graph, no API, no LLM (hard rule 6).

import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  calendarDelta,
  dayDelta,
  formatCalendarDelta,
  isoDate,
  parseIsoDate,
  renderTimeline,
  temporalIntent,
} from './temporal.js';
import type { TemporalClaim } from './temporal.js';
import { TIME_UNKNOWN } from './types.js';

const T = (iso: string): number => parseIsoDate(iso)!;

const claim = (over: Partial<TemporalClaim> & { eventTime: number }): TemporalClaim => ({
  attribute: 'gym_membership',
  value: 'joined',
  sessionId: 's1',
  turnIndex: 0,
  ...over,
});

describe('temporalIntent', () => {
  it('detects the five families', () => {
    expect(temporalIntent('When did I join the gym?').intents).toContain('when');
    expect(temporalIntent('How long did I stay at Acme?').intents).toContain('duration');
    expect(temporalIntent('What did I buy after the laptop?').intents).toContain('ordering');
    expect(temporalIntent('What was my first car?').intents).toContain('first_last');
    expect(temporalIntent('Where do I currently live?').intents).toContain('as_of');
  });

  it('reports a question with no temporal content as not temporal', () => {
    const s = temporalIntent('What is my mortgage lender?');
    expect(s.temporal).toBe(false);
    expect(s.intents).toEqual([]);
  });

  it('collects several families from one question', () => {
    const s = temporalIntent('How long before I moved was my first job?');
    expect(s.temporal).toBe(true);
    expect(s.intents.length).toBeGreaterThan(1);
  });

  it('is case-insensitive and word-anchored (no substring false positives)', () => {
    expect(temporalIntent('WHEN did it start?').temporal).toBe(true);
    // "afternoon" contains "after"; "wheneverish" contains "when" — neither may match on substring
    expect(temporalIntent('Whenever I eat afternoons').intents).not.toContain('ordering');
  });
});

describe('date arithmetic', () => {
  it('isoDate and parseIsoDate round-trip at UTC midnight', () => {
    expect(isoDate(T('2023-08-11'))).toBe('2023-08-11');
    expect(parseIsoDate('nonsense')).toBeNull();
    expect(parseIsoDate(null)).toBeNull();
  });

  it('dayDelta counts whole calendar days and is signed', () => {
    expect(dayDelta(T('2023-01-01'), T('2023-01-31'))).toBe(30);
    expect(dayDelta(T('2023-01-31'), T('2023-01-01'))).toBe(-30);
    expect(dayDelta(T('2024-02-28'), T('2024-03-01'))).toBe(2); // 2024 is a leap year
    expect(dayDelta(T('2023-02-28'), T('2023-03-01'))).toBe(1);
  });

  it('calendarDelta borrows from the month preceding the end month', () => {
    expect(calendarDelta(T('2023-01-31'), T('2023-03-01'))).toEqual({ years: 0, months: 1, days: 1 });
    expect(calendarDelta(T('2022-05-14'), T('2023-08-20'))).toEqual({ years: 1, months: 3, days: 6 });
    expect(calendarDelta(T('2023-06-01'), T('2023-06-01'))).toEqual({ years: 0, months: 0, days: 0 });
  });

  it('formats a calendar delta the way a person says it', () => {
    expect(formatCalendarDelta({ years: 1, months: 3, days: 6 })).toBe('1 year, 3 months, 6 days');
    expect(formatCalendarDelta({ years: 0, months: 0, days: 1 })).toBe('1 day');
    expect(formatCalendarDelta({ years: 0, months: 0, days: 0 })).toBe('0 days');
  });
});

describe('buildTimeline', () => {
  const rows: TemporalClaim[] = [
    claim({ eventTime: T('2023-05-10'), attribute: 'job', value: 'left Acme' }),
    claim({ eventTime: T('2023-01-04'), attribute: 'job', value: 'joined Acme' }),
    claim({ eventTime: T('2023-03-02'), attribute: 'promotion', value: 'senior' }),
  ];

  it('orders claims chronologically and numbers them', () => {
    const t = buildTimeline(rows, '2023-06-01');
    expect(t.rows.map((r) => r.date)).toEqual(['2023-01-04', '2023-03-02', '2023-05-10']);
    expect(t.rows.map((r) => r.ordinal)).toEqual([1, 2, 3]);
    expect(t.rows[0]!.isFirst).toBe(true);
    expect(t.rows[2]!.isLast).toBe(true);
  });

  it('computes the gap from the previous dated claim', () => {
    const t = buildTimeline(rows, '2023-06-01');
    expect(t.rows[0]!.gapDaysFromPrev).toBeNull();
    expect(t.rows[1]!.gapDaysFromPrev).toBe(57);
    expect(t.rows[2]!.gapDaysFromPrev).toBe(69);
  });

  it('computes the age of each claim at the moment the question was asked', () => {
    const t = buildTimeline(rows, '2023-06-01');
    expect(t.rows[0]!.daysBeforeAsking).toBe(148);
    expect(t.rows[2]!.daysBeforeAsking).toBe(22);
    expect(t.askedOn).toBe('2023-06-01');
  });

  it('computes the elapsed span in days and in calendar units', () => {
    const t = buildTimeline(rows, '2023-06-01');
    expect(t.spanDays).toBe(126);
    expect(t.spanCalendar).toEqual({ years: 0, months: 4, days: 6 });
  });

  it('COUNTS undated claims and never places or guesses them', () => {
    const t = buildTimeline([...rows, claim({ eventTime: TIME_UNKNOWN, value: 'three months ago' })], '2023-06-01');
    expect(t.undatedCount).toBe(1);
    expect(t.rows).toHaveLength(3);
    expect(t.rows.some((r) => r.value === 'three months ago')).toBe(false);
  });

  it('degrades gracefully when nothing is dated', () => {
    const t = buildTimeline([claim({ eventTime: TIME_UNKNOWN }), claim({ eventTime: TIME_UNKNOWN })], '2023-06-01');
    expect(t.rows).toEqual([]);
    expect(t.spanDays).toBeNull();
    expect(t.spanCalendar).toBeNull();
    expect(t.undatedCount).toBe(2);
  });

  it('omits the ages when the caller has no question date', () => {
    const t = buildTimeline(rows, null);
    expect(t.askedOn).toBeNull();
    expect(t.rows.every((r) => r.daysBeforeAsking === null)).toBe(true);
  });

  it('breaks event_time ties by the caller’s original order (pure function of the input)', () => {
    const tied: TemporalClaim[] = [
      claim({ eventTime: T('2023-01-01'), value: 'B' }),
      claim({ eventTime: T('2023-01-01'), value: 'A' }),
    ];
    expect(buildTimeline(tied, null).rows.map((r) => r.value)).toEqual(['B', 'A']);
  });
});

describe('renderTimeline', () => {
  const rows: TemporalClaim[] = [
    claim({ eventTime: T('2023-01-04'), attribute: 'gym_membership', value: 'joined FitLife' }),
    claim({ eventTime: T('2023-03-02'), attribute: 'gym_membership', value: 'switched to CoreGym' }),
  ];

  it('prints ordinals, gaps, ages and the elapsed span', () => {
    const out = renderTimeline(buildTimeline(rows, '2023-06-01'));
    expect(out).toContain('#1 2023-01-04');
    expect(out).toContain('EARLIEST');
    expect(out).toContain('#2 2023-03-02');
    expect(out).toContain('+57d after #1');
    expect(out).toContain('LATEST');
    expect(out).toContain('Elapsed earliest→latest: 57 days');
    expect(out).toContain('gym membership: joined FitLife');
  });

  it('returns an empty block when fewer than two claims are dated (one point is not a timeline)', () => {
    expect(renderTimeline(buildTimeline([rows[0]!], '2023-06-01'))).toBe('');
    expect(renderTimeline(buildTimeline([claim({ eventTime: TIME_UNKNOWN })], '2023-06-01'))).toBe('');
  });

  it('discloses undated claims rather than hiding them', () => {
    const out = renderTimeline(buildTimeline([...rows, claim({ eventTime: TIME_UNKNOWN })], '2023-06-01'));
    expect(out).toContain('1 claim(s) above carry no event_time');
  });

  it('caps the printed rows and says how many it dropped', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      claim({ eventTime: T('2023-01-01') + i * 86400, value: `v${i}` }),
    );
    const out = renderTimeline(buildTimeline(many, '2023-06-01'), 10);
    expect(out).toContain('(+30 more dated claims omitted)');
  });

  it('truncates a long label — the timeline indexes the material, it does not copy it', () => {
    const long = claim({ eventTime: T('2023-04-01'), attribute: '', value: 'x'.repeat(400) });
    const out = renderTimeline(buildTimeline([rows[0]!, long], '2023-06-01'));
    const line = out.split('\n').find((l) => l.startsWith('#2'))!;
    expect(line).toContain('…');
    expect(line.length).toBeLessThan(200);
    expect(out).not.toContain('x'.repeat(200));
  });

  it('leaves a short label intact', () => {
    const out = renderTimeline(buildTimeline(rows, '2023-06-01'));
    expect(out).toContain('gym membership: joined FitLife');
    expect(out).not.toContain('…');
  });

  it('is deterministic — the same input renders byte-identically', () => {
    const a = renderTimeline(buildTimeline(rows, '2023-06-01'));
    const b = renderTimeline(buildTimeline(rows, '2023-06-01'));
    expect(a).toBe(b);
  });
});
