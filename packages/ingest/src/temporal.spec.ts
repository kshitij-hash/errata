import { describe, it, expect } from 'vitest';
import {
  addDaysIso,
  addMonthsIso,
  monthNumber,
  parseCount,
  parseUnit,
  resolveAbsoluteDate,
  resolveRelative,
  shiftIso,
} from './temporal.js';
import { epochToIso, isoToEpoch } from './text.js';

describe('date arithmetic', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDaysIso('2023-05-22', 1)).toBe('2023-05-23');
    expect(addDaysIso('2023-05-31', 1)).toBe('2023-06-01');
    expect(addDaysIso('2023-01-01', -1)).toBe('2022-12-31');
    expect(addDaysIso('2024-02-28', 1)).toBe('2024-02-29'); // leap year
    expect(addDaysIso('2023-02-28', 1)).toBe('2023-03-01');
  });

  it('clamps month arithmetic to the end of the target month instead of rolling over', () => {
    expect(addMonthsIso('2023-03-31', -1)).toBe('2023-02-28'); // NOT 2023-03-03
    expect(addMonthsIso('2024-03-31', -1)).toBe('2024-02-29');
    expect(addMonthsIso('2023-01-31', 1)).toBe('2023-02-28');
    expect(addMonthsIso('2023-05-22', -3)).toBe('2023-02-22');
    expect(addMonthsIso('2023-05-22', -12)).toBe('2022-05-22');
    expect(addMonthsIso('2023-11-15', 3)).toBe('2024-02-15');
  });

  it('shiftIso keeps sub-day offsets on the anchor day (day precision, honestly stated)', () => {
    expect(shiftIso('2023-05-22', 3, 'hour', -1)).toBe('2023-05-22');
    expect(shiftIso('2023-05-22', 45, 'minute', -1)).toBe('2023-05-22');
    expect(shiftIso('2023-05-22', 2, 'week', -1)).toBe('2023-05-08');
    expect(shiftIso('2023-05-22', 1, 'decade', -1)).toBe('2013-05-22');
  });
});

describe('parseCount / parseUnit', () => {
  it('reads exact counts only', () => {
    expect(parseCount('3')).toBe(3);
    expect(parseCount('three')).toBe(3);
    expect(parseCount('a')).toBe(1);
    expect(parseCount('an')).toBe(1);
    expect(parseCount('a few')).toBeNull();
    expect(parseCount('several')).toBeNull();
    expect(parseCount('a couple of')).toBeNull();
  });
  it('normalizes unit spellings', () => {
    expect(parseUnit('months')).toBe('month');
    expect(parseUnit('wk')).toBe('week');
    expect(parseUnit('hrs')).toBe('hour');
    expect(parseUnit('fortnights')).toBeNull();
  });
  it('reads month names and abbreviations', () => {
    expect(monthNumber('December')).toBe(12);
    expect(monthNumber('dec')).toBe(12);
    expect(monthNumber('Sept')).toBe(9);
    expect(monthNumber('Smarch')).toBe(0);
  });
});

// The whole point of ingest-time normalization: with a session anchor, "three months ago" names an
// absolute day, and the reader should never have to do that sum. Without one — or without an exact
// count — nothing is written, because the alternative is guessing.
describe('resolveRelative — the normalization table', () => {
  const ANCHOR = '2023-05-22'; // a Monday

  const RESOLVES: [string, string][] = [
    ['yesterday', '2023-05-21'],
    ['Yesterday', '2023-05-21'],
    ['the day before yesterday', '2023-05-20'],
    ['last night', '2023-05-21'],
    ['today', '2023-05-22'],
    ['this morning', '2023-05-22'],
    ['tonight', '2023-05-22'],
    ['tomorrow', '2023-05-23'],
    ['the day after tomorrow', '2023-05-24'],
    ['last week', '2023-05-15'],
    ['next week', '2023-05-29'],
    ['last month', '2023-04-22'],
    ['next month', '2023-06-22'],
    ['last year', '2022-05-22'],
    ['this week', '2023-05-22'],
    ['this month', '2023-05-22'],
    ['two months ago', '2023-03-22'],
    ['three months ago', '2023-02-22'],
    ['3 months ago', '2023-02-22'],
    ['about three months ago', '2023-02-22'],
    ['a week ago', '2023-05-15'],
    ['two weeks ago', '2023-05-08'],
    ['10 days ago', '2023-05-12'],
    ['a year ago', '2022-05-22'],
    ['three hours ago', '2023-05-22'], // sub-day: stays on the anchor day
    ['in 3 weeks', '2023-06-12'],
    ['in two months', '2023-07-22'],
    ['two weeks from now', '2023-06-05'],
    ['three months ago.', '2023-02-22'], // trailing punctuation is not part of the phrase
  ];
  it.each(RESOLVES)('resolves %j against 2023-05-22 → %s', (phrase, expected) => {
    expect(resolveRelative(phrase, ANCHOR)).toBe(expected);
  });

  const STAYS_UNRESOLVED: string[] = [
    'a few weeks ago',
    'several months ago',
    'a couple of days ago',
    'last Friday', // needs a week-boundary convention the corpus never states
    'next Monday',
    'two weeks later', // anchored on an event, not on the session
    'the following month',
    'recently',
    'lately',
    'soon',
    'in the summer',
    '',
    'a fortnight ago',
  ];
  it.each(STAYS_UNRESOLVED)('refuses to guess %j', (phrase) => {
    expect(resolveRelative(phrase, ANCHOR)).toBe('');
  });

  it('resolves nothing at all without an anchor — no anchor, no arithmetic', () => {
    for (const [phrase] of RESOLVES) expect(resolveRelative(phrase, '')).toBe('');
    expect(resolveRelative('yesterday', 'not-a-date')).toBe('');
  });

  it('a resolved phrase round-trips through the pipeline epoch helpers', () => {
    const iso = resolveRelative('three months ago', ANCHOR);
    const epoch = isoToEpoch(iso);
    expect(epoch).toBeGreaterThan(0);
    expect(epochToIso(epoch)).toBe(iso);
    expect(epoch).toBe(Date.UTC(2023, 1, 22) / 1000);
  });
});

describe('resolveAbsoluteDate', () => {
  it('resolves fully-specified dates in every surface form the corpus uses', () => {
    expect(resolveAbsoluteDate('2023-05-22')).toBe('2023-05-22');
    expect(resolveAbsoluteDate('2023/05/22')).toBe('2023-05-22');
    expect(resolveAbsoluteDate('2023/5/2')).toBe('2023-05-02');
    expect(resolveAbsoluteDate('December 22, 2023')).toBe('2023-12-22');
    expect(resolveAbsoluteDate('Dec. 22 2023')).toBe('2023-12-22');
    expect(resolveAbsoluteDate('December 22nd, 2023')).toBe('2023-12-22');
    expect(resolveAbsoluteDate('22 December 2023')).toBe('2023-12-22');
    expect(resolveAbsoluteDate('22nd of December, 2023')).toBe('2023-12-22');
  });

  it('leaves under-specified and locale-ambiguous forms alone', () => {
    expect(resolveAbsoluteDate('December 22nd')).toBe(''); // which year?
    expect(resolveAbsoluteDate('June 2023')).toBe(''); // which day?
    expect(resolveAbsoluteDate('3/5/2024')).toBe(''); // March 5 or 3 May? the text does not say
    expect(resolveAbsoluteDate('2023-13-01')).toBe(''); // not a month
    expect(resolveAbsoluteDate('2023-02-30')).toBe(''); // not a day
    expect(resolveAbsoluteDate('February 30, 2023')).toBe('');
    expect(resolveAbsoluteDate('sometime in spring')).toBe('');
  });
});
