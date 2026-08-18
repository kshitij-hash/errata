// packages/core/src/temporal.ts — the deterministic temporal layer of the answer path.
//
// WHY THIS EXISTS. Temporal reasoning was the arm's weakest named question type (41.0% over 39
// questions; 30.3 on the non-abstention ability cut). The material handed to synthesis already
// carried each claim's date, but every derived quantity a temporal question actually asks for —
// which event came first, how many days apart two events are, how long ago something was, what the
// value was AS OF some moment — was left for the language model to work out from a bag of ISO
// strings. That is arithmetic, and arithmetic is exactly what a graph with `event_time` on every
// claim should not be delegating to a token predictor.
//
// So the code does the arithmetic. `temporalIntent` decides (with cheap regex heuristics, NO model
// call — hard rule 2 keeps the answer path model-free apart from the one synthesis seam) whether a
// question is asking about time at all; `buildTimeline` folds the retrieved claims' `event_time`
// into an ordered timeline with ordinals, gaps, ages and an elapsed span; `renderTimeline` prints
// it. The result is injected into the MATERIAL, never into the answer prompt template — the
// template's sha256 is the cross-arm validity gate (see prompt.ts) and it does not move.
//
// The graph does time; the prompt only phrases it.
//
// Pure functions of (question, rows). No I/O, no clock: the caller supplies "now" as the question
// date, so two identical asks produce identical text.

import { TIME_UNKNOWN } from './types.js';

const DAY_SECONDS = 86400;

/** The families of temporal question this layer recognizes. A question can be several at once. */
export const TEMPORAL_INTENTS = ['when', 'duration', 'ordering', 'first_last', 'as_of'] as const;
export type TemporalIntent = (typeof TEMPORAL_INTENTS)[number];

/**
 * Intent probes. Deliberately lexical and deliberately narrow: a false positive costs a few dozen
 * tokens of unused timeline, while a false negative costs the whole point of the layer, so each
 * pattern is anchored on words that only carry temporal weight.
 */
const PROBES: Readonly<Record<TemporalIntent, RegExp>> = {
  when: /\b(when|what\s+(?:date|day|month|year)|which\s+(?:date|day|month|year)|on\s+what\s+(?:date|day)|how\s+long\s+ago)\b/i,
  duration:
    /\b(how\s+long|how\s+many\s+(?:days?|weeks?|months?|years?)|duration|how\s+much\s+time|time\s+(?:between|elapsed)|gap\s+between|since\s+(?:then|when))\b/i,
  ordering: /\b(before|after|prior\s+to|preceded?|preceding|following|subsequent|next|previous|earlier|later|order|sequence|in\s+between|between\s+the)\b/i,
  first_last:
    /\b(first|last|earliest|latest|most\s+recent|initial(?:ly)?|original(?:ly)?|final(?:ly)?|began|started|start(?:ed)?\s+out|end(?:ed)?\s+up)\b/i,
  as_of: /\b(as\s+of|currently|right\s+now|at\s+present|nowadays|these\s+days|still|up\s+to\s+now|to\s+date|so\s+far)\b/i,
};

export interface TemporalSignal {
  /** every intent family the question matched, in TEMPORAL_INTENTS order */
  intents: TemporalIntent[];
  /** true iff at least one family matched — the gate the ask path uses */
  temporal: boolean;
}

/**
 * Does this question ask about time, and how?
 *
 * Cheap heuristics over the raw question text — no LLM call, no lexicon lookup, no graph read.
 */
export function temporalIntent(question: string): TemporalSignal {
  const intents = TEMPORAL_INTENTS.filter((k) => PROBES[k].test(question));
  return { intents, temporal: intents.length > 0 };
}

/** One claim, reduced to what the timeline needs. */
export interface TemporalClaim {
  /** epoch seconds; TIME_UNKNOWN (-1) when the extractor could not date it */
  eventTime: number;
  attribute: string;
  value: string;
  sessionId: string;
  turnIndex: number;
}

/** A dated claim, placed. Every derived number here was computed, not inferred. */
export interface TimelineRow {
  /** 1-based position in the chronological order */
  ordinal: number;
  /** UTC calendar date of `eventTime` */
  date: string;
  eventTime: number;
  attribute: string;
  value: string;
  sessionId: string;
  turnIndex: number;
  /** whole days from the previous row's date; null on the first row */
  gapDaysFromPrev: number | null;
  /** whole days between this date and the question date; negative if it is in the future */
  daysBeforeAsking: number | null;
  isFirst: boolean;
  isLast: boolean;
}

export interface Timeline {
  rows: TimelineRow[];
  /** claims in the window whose `event_time` is TIME_UNKNOWN — they are NOT placed */
  undatedCount: number;
  /** whole days from the earliest to the latest dated claim; null when fewer than two are dated */
  spanDays: number | null;
  /** calendar breakdown of `spanDays` (years/months/days), null under the same condition */
  spanCalendar: CalendarDelta | null;
  /** the question date the ages were measured against, when the caller supplied one */
  askedOn: string | null;
}

export interface CalendarDelta {
  years: number;
  months: number;
  days: number;
}

/** epoch seconds → UTC `YYYY-MM-DD`. */
export function isoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * The leading calendar date of a string → epoch seconds at UTC midnight; null when there isn't one.
 *
 * Both separators are accepted because both are in play: claims render `YYYY-MM-DD`, while the
 * corpus's own `question_date` is `2023/05/30 (Tue) 23:40`. An ISO-only parser silently returns
 * null on the second form, and every "days before asking" quietly disappears — so the tolerant
 * parse is load-bearing, not politeness. Anything after the date is ignored.
 */
export function parseIsoDate(raw: string | undefined | null): number | null {
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})/.exec(raw ?? '');
  if (!m) return null;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** Whole days between two epoch-second instants, measured on the UTC calendar (b − a). */
export function dayDelta(a: number, b: number): number {
  const floorDay = (t: number): number => Math.floor(t / DAY_SECONDS);
  return floorDay(b) - floorDay(a);
}

/** Add whole months to an epoch instant, CLAMPING the day to the target month's length
 *  (2023-01-31 + 1 month = 2023-02-28, never 2023-03-03). */
function addMonthsClamped(epochSeconds: number, months: number): number {
  const d = new Date(epochSeconds * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const daysInTarget = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), daysInTarget);
  return Math.floor(Date.UTC(y, m, day) / 1000);
}

/**
 * Calendar breakdown of the interval [a, b] — the "1 year 2 months 3 days" a person would say.
 *
 * Computed by ANCHORING, not by subtracting fields and borrowing: walk whole months forward from
 * the start (clamping the day of month), then count the days left over. Field subtraction gets
 * month-end intervals wrong — 2023-01-31 → 2023-03-01 comes out as "1 month, -2 days" — and a
 * negative day count inside a published number is exactly the quiet nonsense this layer exists to
 * remove. The anchored form gives 1 month, 1 day, which is what a date library returns and what a
 * person means.
 */
export function calendarDelta(a: number, b: number): CalendarDelta {
  if (b < a) {
    const flipped = calendarDelta(b, a);
    return { years: -flipped.years, months: -flipped.months, days: -flipped.days };
  }
  const from = new Date(a * 1000);
  const to = new Date(b * 1000);
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (months > 0 && addMonthsClamped(a, months) > b) months -= 1;
  const days = months <= 0 ? dayDelta(a, b) : dayDelta(addMonthsClamped(a, months), b);
  return { years: Math.floor(months / 12), months: months % 12, days };
}

/** "1 year, 2 months, 3 days"; "0 days" when the interval is empty. */
export function formatCalendarDelta(d: CalendarDelta): string {
  const parts: string[] = [];
  if (d.years !== 0) parts.push(`${d.years} year${Math.abs(d.years) === 1 ? '' : 's'}`);
  if (d.months !== 0) parts.push(`${d.months} month${Math.abs(d.months) === 1 ? '' : 's'}`);
  if (d.days !== 0 || parts.length === 0) parts.push(`${d.days} day${Math.abs(d.days) === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/**
 * Fold the retrieved claims into a chronological timeline.
 *
 * Undated claims (`event_time === -1`) are COUNTED, never placed and never guessed at — the
 * extractor writes -1 when it could not date a claim, and inventing an order for those is exactly
 * the kind of confident fiction this whole layer exists to remove. Ties on `event_time` keep the
 * caller's original order, so the timeline is a pure function of (rows, questionDate).
 */
export function buildTimeline(claims: readonly TemporalClaim[], questionDateIso?: string | null): Timeline {
  const askedAt = parseIsoDate(questionDateIso ?? null);
  const dated = claims
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => Number.isFinite(c.eventTime) && c.eventTime > TIME_UNKNOWN && c.eventTime > 0)
    .sort((x, y) => (x.c.eventTime !== y.c.eventTime ? x.c.eventTime - y.c.eventTime : x.i - y.i));

  const rows: TimelineRow[] = dated.map(({ c }, idx) => {
    const prev = idx > 0 ? dated[idx - 1]!.c.eventTime : null;
    return {
      ordinal: idx + 1,
      date: isoDate(c.eventTime),
      eventTime: c.eventTime,
      attribute: c.attribute,
      value: c.value,
      sessionId: c.sessionId,
      turnIndex: c.turnIndex,
      gapDaysFromPrev: prev == null ? null : dayDelta(prev, c.eventTime),
      daysBeforeAsking: askedAt == null ? null : dayDelta(c.eventTime, askedAt),
      isFirst: idx === 0,
      isLast: idx === dated.length - 1,
    };
  });

  const first = rows[0];
  const last = rows.at(-1);
  const spanDays = first && last && rows.length > 1 ? dayDelta(first.eventTime, last.eventTime) : null;
  return {
    rows,
    undatedCount: claims.length - rows.length,
    spanDays,
    spanCalendar: spanDays == null || !first || !last ? null : calendarDelta(first.eventTime, last.eventTime),
    askedOn: askedAt == null ? null : isoDate(askedAt),
  };
}

/**
 * Print the timeline as a block for the MATERIAL.
 *
 * Everything on a line is a computed quantity: the ordinal, the gap from the previous dated event,
 * the age at the moment the question was asked, and the FIRST/LATEST markers. The model's job on a
 * temporal question is reduced to reading the right line and phrasing it.
 *
 * Returns `''` when fewer than two claims are dated — one point is not a timeline, and a block that
 * says nothing is worse than no block. That is also the graceful path for a history whose claims
 * carry `event_time = -1`, which does happen: the values then read as free text ("three months")
 * and the layer must not pretend to have ordered them.
 */
/** The timeline is an INDEX over the material, not a second copy of it: every label it prints
 *  already appears in full above it, so a label is truncated rather than allowed to double the
 *  context of every temporal question. */
export const TIMELINE_LABEL_MAX = 100;

function truncateLabel(s: string): string {
  return s.length <= TIMELINE_LABEL_MAX ? s : `${s.slice(0, TIMELINE_LABEL_MAX - 1).trimEnd()}…`;
}

export function renderTimeline(t: Timeline, maxRows = 30): string {
  if (t.rows.length < 2) return '';
  const lines: string[] = [];
  lines.push('--- COMPUTED TIMELINE (derived from the stored event_time of the claims above) ---');
  if (t.askedOn) lines.push(`Question asked on ${t.askedOn}. Ages below are exact whole days.`);
  const shown = t.rows.slice(0, maxRows);
  for (const r of shown) {
    const bits: string[] = [];
    if (r.gapDaysFromPrev != null) bits.push(`+${r.gapDaysFromPrev}d after #${r.ordinal - 1}`);
    if (r.daysBeforeAsking != null) {
      bits.push(r.daysBeforeAsking >= 0 ? `${r.daysBeforeAsking}d before asking` : `${-r.daysBeforeAsking}d after asking`);
    }
    if (r.isFirst) bits.push('EARLIEST');
    if (r.isLast) bits.push('LATEST');
    const meta = bits.length ? ` [${bits.join('; ')}]` : '';
    // an empty `attribute` means the caller already folded the label into `value` (the ask path
    // groups several claims from one turn behind one evidence span) — do not print a bare colon.
    const label = r.attribute ? `${r.attribute.replace(/_/g, ' ')}: ${r.value}` : r.value;
    lines.push(`#${r.ordinal} ${r.date}${meta} — ${truncateLabel(label)}`);
  }
  if (t.rows.length > shown.length) lines.push(`(+${t.rows.length - shown.length} more dated claims omitted)`);
  if (t.spanDays != null && t.spanCalendar) {
    lines.push(`Elapsed earliest→latest: ${t.spanDays} days (${formatCalendarDelta(t.spanCalendar)}).`);
  }
  if (t.undatedCount > 0) {
    lines.push(`${t.undatedCount} claim(s) above carry no event_time and are NOT placed on this timeline.`);
  }
  lines.push('--- END COMPUTED TIMELINE ---');
  return lines.join('\n');
}
