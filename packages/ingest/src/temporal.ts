// packages/ingest/src/temporal.ts — deterministic relative-time resolution against a session anchor.
//
// LongMemEval sessions carry a date (`haystack_dates`, index-aligned; the reader parses it into
// `Session.dateIso`). A transcript that says "three months ago" therefore names an ABSOLUTE instant
// — but only if you know the anchor. Today that arithmetic is pushed onto the reader: the claim
// stores the free text "three months" and every downstream consumer has to redo the sum.
//
// This module does it once, at ingest, and ONLY when the answer is forced by the data:
//   * an anchor is present, AND
//   * the phrase names an exact offset ("two months ago", "yesterday", "in 3 weeks").
// Everything else — "a few weeks ago", "last Friday", "later that month", a bare month name — is
// left UNRESOLVED and the caller keeps the codebase's -1 / session-date fallback. Guessing a date
// the corpus never wrote would be inventing evidence, which is the one thing the write path may
// never do.
//
// Day precision throughout: the resolved value is a 'YYYY-MM-DD' in UTC, matching `Session.dateIso`
// and `isoToEpoch`. Sub-day offsets ("three hours ago") resolve to the anchor DAY, which is what
// day-precision arithmetic can honestly say about them.

/** 'YYYY-MM-DD' → [y, m, d] (1-based month), or null. */
function parseIso(iso: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return [+m[1]!, +m[2]!, +m[3]!];
}

function fmtIso(y: number, mo: number, d: number): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)}`;
}

/** Days in a (1-based) month of a year, UTC. */
function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

export function addDaysIso(iso: string, days: number): string {
  const ymd = parseIso(iso);
  if (!ymd) return '';
  const t = Date.UTC(ymd[0], ymd[1] - 1, ymd[2]) + days * 86_400_000;
  const d = new Date(t);
  return fmtIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Month arithmetic with END-OF-MONTH CLAMPING: 2023-03-31 minus one month is 2023-02-28, not
 * 2023-03-03. Date.UTC would roll over; clamping is the reading a person means.
 */
export function addMonthsIso(iso: string, months: number): string {
  const ymd = parseIso(iso);
  if (!ymd) return '';
  const [y, mo, d] = ymd;
  const total = y * 12 + (mo - 1) + months;
  const ny = Math.floor(total / 12);
  const nmo = (total % 12) + 1;
  return fmtIso(ny, nmo, Math.min(d, daysInMonth(ny, nmo)));
}

/** Number words the resolver treats as exact counts. "a"/"an" are 1; "a few"/"several" are NOT here. */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
};

/** Words that name a COUNT but not an exact one — extracted as text, never resolved to a date. */
export const VAGUE_QUANTIFIERS: readonly string[] = ['a few', 'a couple', 'a couple of', 'several', 'many', 'some'];

export type TimeUnit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year' | 'decade';

const UNIT_ALIASES: Readonly<Record<string, TimeUnit>> = {
  min: 'minute', mins: 'minute', minute: 'minute', minutes: 'minute',
  hr: 'hour', hrs: 'hour', hour: 'hour', hours: 'hour',
  day: 'day', days: 'day',
  week: 'week', weeks: 'week', wk: 'week', wks: 'week',
  month: 'month', months: 'month', mo: 'month',
  year: 'year', years: 'year', yr: 'year', yrs: 'year',
  decade: 'decade', decades: 'decade',
};

export function parseUnit(raw: string): TimeUnit | null {
  return UNIT_ALIASES[raw.toLowerCase()] ?? null;
}

/** Exact count from a digit string or a number word; null when the phrase is vague ("a few"). */
export function parseCount(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return NUMBER_WORDS[t] ?? null;
}

/** Apply a signed offset of `count` `unit`s to an anchor day. Sub-day units land on the anchor day. */
export function shiftIso(anchorIso: string, count: number, unit: TimeUnit, sign: 1 | -1): string {
  switch (unit) {
    case 'minute':
    case 'hour':
      return anchorIso; // day precision: a sub-day offset does not leave the anchor day
    case 'day':
      return addDaysIso(anchorIso, sign * count);
    case 'week':
      return addDaysIso(anchorIso, sign * count * 7);
    case 'month':
      return addMonthsIso(anchorIso, sign * count);
    case 'year':
      return addMonthsIso(anchorIso, sign * count * 12);
    case 'decade':
      return addMonthsIso(anchorIso, sign * count * 120);
  }
}

const DEICTIC: Readonly<Record<string, number>> = {
  'the day before yesterday': -2,
  yesterday: -1,
  'last night': -1,
  today: 0,
  'this morning': 0,
  'this afternoon': 0,
  'this evening': 0,
  tonight: 0,
  'right now': 0,
  tomorrow: 1,
  'the day after tomorrow': 2,
};

// "this week"/"this month"/"this year" contain the anchor day by definition — resolving them to the
// anchor states no more than the session date already does, and states nothing false.
const THIS_PERIOD = /^this (week|month|year|weekend)$/;
const LAST_NEXT = /^(last|next|past) (week|month|year)$/;
const AGO = /^(?:about |around |roughly |approximately |over |nearly |almost )?([a-z]+|\d+)[- ](minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|decades?) ago$/;
const IN_FUTURE = /^in ([a-z]+|\d+) (minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|decades?)$/;
const FROM_NOW = /^([a-z]+|\d+) (minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|decades?) from now$/;

/**
 * Resolve a relative-time PHRASE against a 'YYYY-MM-DD' anchor.
 *
 * @returns the resolved 'YYYY-MM-DD', or '' when the phrase is not exactly resolvable (or there is
 *          no anchor). '' is the caller's signal to fall back to the session date, exactly as the
 *          rest of the pipeline already does — never to guess.
 *
 * Deliberately NOT resolved, and why:
 *   "a few weeks ago", "several months ago"  — no exact count.
 *   "last Friday", "next Monday"             — depends on a week-boundary convention the corpus
 *                                              never states; two readers disagree by 7 days.
 *   "two weeks later", "the following month"  — anchored on a previously-mentioned event, not on
 *                                              the session date.
 */
export function resolveRelative(phrase: string, anchorIso: string): string {
  if (!anchorIso || !parseIso(anchorIso)) return '';
  const p = phrase.toLowerCase().replace(/[.,!?;:]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!p) return '';

  const deictic = DEICTIC[p];
  if (deictic !== undefined) return addDaysIso(anchorIso, deictic);

  if (THIS_PERIOD.test(p)) return anchorIso;

  const lastNext = LAST_NEXT.exec(p);
  if (lastNext) {
    const sign: 1 | -1 = lastNext[1] === 'next' ? 1 : -1;
    const unit = parseUnit(lastNext[2]!)!;
    return shiftIso(anchorIso, 1, unit, sign);
  }

  for (const [re, sign] of [[AGO, -1], [IN_FUTURE, 1], [FROM_NOW, 1]] as const) {
    const m = re.exec(p);
    if (!m) continue;
    const count = parseCount(m[1]!);
    const unit = parseUnit(m[2]!);
    if (count === null || unit === null) return ''; // "a few weeks ago" — vague, never guessed
    return shiftIso(anchorIso, count, unit, sign);
  }

  return '';
}

/**
 * Resolve an ABSOLUTE date surface form to 'YYYY-MM-DD'. Only fully-specified dates resolve:
 * a month with no year ("March 15th") or a month-year with no day ("June 2023") would each need a
 * value the transcript did not write.
 *
 * `3/5/2024` stays unresolved on purpose: month-first vs day-first is a locale convention, not a
 * fact in the text, and picking one silently mislabels every European date in the corpus.
 */
export function resolveAbsoluteDate(raw: string): string {
  const s = raw.trim().replace(/[.,]+$/, '');

  const numeric = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (numeric) {
    const [y, mo, d] = [+numeric[1]!, +numeric[2]!, +numeric[3]!];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo)) return fmtIso(y, mo, d);
    return '';
  }

  const monthFirst = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(s);
  if (monthFirst) return fromMonthName(monthFirst[1]!, +monthFirst[2]!, +monthFirst[3]!);

  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)\.?,?\s+(\d{4})$/i.exec(s);
  if (dayFirst) return fromMonthName(dayFirst[2]!, +dayFirst[1]!, +dayFirst[3]!);

  return '';
}

const MONTHS: readonly string[] = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** Month name or 3-letter abbreviation → 1..12, or 0. */
export function monthNumber(name: string): number {
  const n = name.toLowerCase();
  const i = MONTHS.findIndex((m) => m === n || (n.length >= 3 && m.startsWith(n) && n.length <= 4));
  return i + 1;
}

function fromMonthName(name: string, day: number, year: number): string {
  const mo = monthNumber(name);
  if (mo === 0) return '';
  if (day < 1 || day > daysInMonth(year, mo)) return '';
  return fmtIso(year, mo, day);
}
