// packages/ingest/src/typed.ts — the deterministic TYPED-FACT pass (zero LLM, zero credits).
//
// WHY THIS EXISTS
// ---------------
// Extraction recall, not retrieval, is the accuracy ceiling. The LLM pass is bounded twice: the
// salience gate drops ~28% of turns before the model ever sees them, and the prompt asks for "at
// most 10 claims, the ones a person is most likely to ask back about" for a whole 12-turn batch.
// Both bounds are BUDGET decisions and both are load-bearing failures. History `85fa3a3f` asks for
// the total of four purchases — food bowl $15, measuring cup $5, dental chews $10, flea-and-tick
// collar $20. All four are written in the transcript in plain English. None of them is among the
// 295 claims that history extracted. All four are recoverable by regex.
//
// So: a third pass, alongside the structural pass and the LLM pass, that reads EVERY turn (no
// salience gate — that is the point) and emits one claim per typed span it can quote verbatim.
// Deliberately high recall and low selectivity; selectivity is retrieval's job downstream.
//
// WHY IT CANNOT CORRUPT THE GRAPH
// -------------------------------
// Every attribute it mints is namespaced `typed_*`. No registry entry and no registry synonym
// begins with `typed_`, so `resolveAttribute` always returns registered=false → arity MULTI → the
// conflict step can only ever emit a revision edge for a NEGATE claim matching an existing member,
// and this pass never emits NEGATE. A typed claim therefore cannot supersede an LLM or structural
// claim, and none of them can supersede it. Values coexist, which is the honest state: two amounts
// quoted from two turns are two facts, not a correction.
//
// Claims are appended like every other claim: ids via packages/graph/ids.ts, an exact positional
// citation (session_id, turn_index), a verbatim `evidence_span`, provenance EXTRACTED (they quote
// the transcript), and `extractor_model = typed-extractor@1` so a read path can filter the whole
// pass in or out by that one field.

import type { TimeBasis } from '@errata/core';
import type { History, Turn } from './reader.js';
import type { ExtractedClaim, Extractor } from './extract.js';
import { resolveAbsoluteDate, resolveRelative } from './temporal.js';

/** The extractor tag every claim from this pass carries (`Claim.extractor_model`). */
export const TYPED_MODEL = 'typed-extractor@1';

/** Namespace prefix for every attribute this pass mints. Nothing in the registry starts with it. */
export const TYPED_PREFIX = 'typed_';

export type TypedFamily = 'money' | 'duration' | 'relative_time' | 'date' | 'time' | 'list_item';

export interface TypedClaim extends ExtractedClaim {
  /** which extraction family produced this claim — the dry run's histogram key */
  family: TypedFamily;
  /** true when a session anchor let temporal normalization compute an absolute event_time */
  resolved: boolean;
}

export const ALL_FAMILIES: readonly TypedFamily[] = ['money', 'duration', 'relative_time', 'date', 'time', 'list_item'];

export interface TypedOptions {
  /** items kept from one enumerated list. Generous on purpose: a ten-item answer must survive whole. */
  maxListItems?: number;
  /** per-turn circuit breaker so one pathological turn cannot dominate a history. Not a quality dial. */
  maxClaimsPerTurn?: number;
  /** families to run. Default: all of them. `list_item` is by far the highest-volume family, so a
   *  supervised apply may want to size it separately from the rest. */
  families?: readonly TypedFamily[];
}
const DEFAULTS = { maxListItems: 25, maxClaimsPerTurn: 200 } as const;

// ---------------------------------------------------------------------------------------------
// span plumbing
// ---------------------------------------------------------------------------------------------

const MAX_SPAN = 160;

function span(s: string, n = MAX_SPAN): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

/**
 * Blank out fenced and inline code, PRESERVING LENGTH so every offset computed on the masked text
 * still indexes the original. Extraction runs on the mask; every value and evidence span is sliced
 * out of the original, so what lands in the graph is always the verbatim transcript.
 */
export function maskCode(text: string): string {
  return text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Bounds of the sentence containing [start,end) — the unit stored as `evidence_span`. */
export function sentenceAround(text: string, start: number, end: number): { from: number; to: number } {
  let from = 0;
  for (let i = start - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === '\n') { from = i + 1; break; }
    if ((ch === '.' || ch === '!' || ch === '?') && /\s/.test(text[i + 1] ?? ' ')) { from = i + 1; break; }
  }
  let to = text.length;
  for (let i = end; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\n') { to = i; break; }
    if ((ch === '.' || ch === '!' || ch === '?') && /\s|$/.test(text[i + 1] ?? '')) { to = i + 1; break; }
  }
  return { from, to };
}

// ---------------------------------------------------------------------------------------------
// pattern vocabulary — assembled from parts so each piece can be read and audited on its own
// ---------------------------------------------------------------------------------------------

// Multi-word alternatives MUST precede their prefixes: regex alternation is leftmost-first, so
// `a|a few` would match "a" and strand "few".
const NUM_ANY = '(?:a few|a couple of|a couple|several|\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|an|a)';
// The duration form omits bare "a"/"an" on purpose: "$50 a month" is a RATE, not a duration, and
// admitting it would have made "a month" the single most common "fact" in the corpus.
// The range form comes first so "20-30 minutes" is quoted whole instead of as a truncated "30
// minutes" — a partial quote of a number is a wrong quote.
const NUM_COUNTED = '(?:\\d+(?:\\.\\d+)?\\s?[-–—]\\s?\\d+(?:\\.\\d+)?|a few|a couple of|a couple|several|\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)';
const UNIT = '(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|years?|yrs?|decades?)';
const HEDGE = '(?:about |around |roughly |approximately |over |nearly |almost )?';
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const PERIOD = '(?:week|month|year|weekend|night|morning|afternoon|evening|summer|winter|spring|fall|autumn|monday|tuesday|wednesday|thursday|friday|saturday|sunday)';

// The digit group must END on a digit. `\d[\d,]*` looks right and is not: on "…for $15, and a
// measuring cup…" it matches "$15," — comma included — and the value stored is a quote of a number
// that does not exist. That single character is why the 85fa3a3f addends stayed invisible on the
// first pass of this module.
const AMOUNT = '\\d(?:[\\d,]*\\d)?(?:\\.\\d+)?';
const MONEY_RE = new RegExp(
  [
    // symbol-led: $15, US$1,200.50, €20, £1.5k
    `(?:(?:US|CA|AU|NZ)?\\$|€|£|¥|₹)\\s?${AMOUNT}(?:\\s?(?:k|m|bn|thousand|million|billion))?`,
    // word-led: 15 dollars, 1,200 USD, 30 euros
    `\\b${AMOUNT}\\s?(?:k|m)?\\s?(?:dollars?|euros?|pounds?(?: sterling)?|yen|rupees?|USD|EUR|GBP|JPY|INR|CAD|AUD)\\b`,
  ].join('|'),
  'gi',
);

const RELATIVE_RE = new RegExp(
  [
    'the day before yesterday',
    'the day after tomorrow',
    `${HEDGE}${NUM_ANY}[- ]${UNIT} ago`,
    `${NUM_ANY} ${UNIT} from now`,
    `in ${NUM_ANY} ${UNIT}`,
    `(?:last|next|this|past) ${PERIOD}`,
    'yesterday',
    'tomorrow',
    'tonight',
    'today',
  ].map((p) => `(?:${p})`).join('|'),
  'gi',
);

const DURATION_RE = new RegExp(`\\b${NUM_COUNTED}[- ]${UNIT}\\b`, 'gi');

const DATE_RE = new RegExp(
  [
    '\\b\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}\\b',
    '\\b\\d{1,2}/\\d{1,2}/\\d{4}\\b',
    `\\b${MONTH}\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}\\b`,
    `\\b\\d{1,2}(?:st|nd|rd|th)? (?:of )?${MONTH}\\.?,? \\d{4}\\b`,
    `\\b${MONTH} \\d{1,2}(?:st|nd|rd|th)?\\b`,
    `\\b${MONTH} \\d{4}\\b`,
  ].join('|'),
  'gi',
);

const TIME_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)?|\b\d{1,2}\s?(?:am|pm)\b/gi;

// ---------------------------------------------------------------------------------------------
// local noun-phrase derivation (money only)
// ---------------------------------------------------------------------------------------------

// Tail words that stand BETWEEN a noun phrase and its amount ("the chews are $10", "it cost me
// about $40"). Stripped from the right until a real content word remains.
const CONNECTOR = new Set([
  // copulas and the transaction verbs money hangs off
  'is', 'was', 'are', 'were', 'be', 'been', 'being', 'am', "'s", 'costs', 'cost', 'costing',
  'came', 'ran', 'runs', 'totals', 'totalled', 'totaled', 'total', 'priced', 'worth', 'spent',
  'spend', 'spending', 'paid', 'pay', 'paying', 'charged', 'charges', 'set', 'went', 'raised',
  'raising', 'raise', 'made', 'make', 'making', 'earned', 'earning', 'earn', 'got', 'get',
  'getting', 'bought', 'buy', 'buying', 'sold', 'sell', 'selling', 'saved', 'save', 'saving',
  'donated', 'donate', 'donating', 'gave', 'give', 'giving', 'put', 'need', 'needed', 'want',
  'wanted', 'have', 'has', 'had', 'will', 'would', 'could', 'should', 'can',
  // hedges and adverbs
  'only', 'just', 'about', 'around', 'roughly', 'approximately', 'nearly', 'almost', 'recently',
  'also', 'still', 'already', 'back', 'up', 'out', 'over', 'more', 'less', 'than', 'each', 'per',
  'another', 'maybe', 'like', 'now', 'then', 'so',
  // function words and pronouns
  'at', 'for', 'to', 'of', 'me', 'us', 'which', 'that', 'it', 'they', 'them', 'and', 'but', 'or',
  'plus', 'i', 'we', 'you', 'he', 'she', 'myself', 'yourself', 'himself', 'herself', 'ourselves',
  'themselves',
]);
// Leading words carrying no retrieval signal, dropped from the left of a finished phrase.
const LEADING = new Set(['the', 'a', 'an', 'my', 'our', 'his', 'her', 'their', 'your', 'its', 'this', 'that', 'these', 'those', 'some', 'any', 'i', 'we', 'they', 'he', 'she', 'it', 'and', 'but', 'or', 'of', 'to', 'for']);
// `for` is here as well as in CONNECTOR: in "a collar for Max, which was $20" the head noun is the
// collar and "for Max" modifies it. The `$X for Y` reading is handled separately, and first, by
// TRAILING_TARGET — this set only ever looks at text BEFORE the amount.
const PREPOSITION = new Set(['from', 'at', 'in', 'on', 'by', 'with', 'for', 'down', 'near', 'inside', 'outside', 'via', 'off', 'through']);

const MAX_NP_TOKENS = 4;

function tokensOf(s: string): string[] {
  return s.split(/\s+/).map((t) => t.replace(/^[^\w$€£¥₹'-]+|[^\w'-]+$/g, '')).filter(Boolean);
}

/** `$500 for the cause`, `$20 on a new collar` — the unambiguous form, so it is tried first. */
const TRAILING_TARGET = /^[,;]?\s*(?:each|apiece)?\s*(?:for|on|towards?)\s+([\w'-]+(?:\s+[\w'-]+){0,3})/i;

/**
 * The noun phrase a money span is about, derived from its own sentence — "the chews are $10 a pack"
 * → "chews", "a measuring cup from the pet store down the street for $5" → "measuring cup".
 *
 * The text AFTER the amount is tried first, because `$X for Y` states the target outright and can
 * only be read one way. Failing that, the text BEFORE gets two cheap passes run until stable: strip
 * copulas/verbs/adverbs off the right, then strip a trailing prepositional phrase ("from Amazon",
 * "down the street") which modifies the head rather than being it.
 *
 * Returns '' when nothing is cheaply derivable. The caller then falls back to a subject-free
 * namespaced attribute — an amount with no owner is still a quotable fact, and guessing an owner
 * would be inventing one.
 */
export function localNounPhrase(text: string, start: number, end: number): string {
  const bounds = sentenceAround(text, start, end);

  const after = TRAILING_TARGET.exec(text.slice(end, bounds.to));
  if (after) {
    const np = trimPhrase(tokensOf(after[1]!));
    if (np) return np;
  }

  let toks = tokensOf(text.slice(bounds.from, start)).slice(-10);
  for (let pass = 0; pass < 4; pass++) {
    const before = toks.length;
    // copulas, verbs, hedges — and OTHER amounts: "Total recurring expenses: $50 + $10 = $60" must
    // not make "$50" part of the noun phrase that owns "$10".
    while (toks.length > 0 && (CONNECTOR.has(toks[toks.length - 1]!.toLowerCase()) || IS_NUMERIC.test(toks[toks.length - 1]!))) toks.pop();
    for (let i = toks.length - 1; i >= Math.max(0, toks.length - MAX_NP_TOKENS); i--) {
      if (PREPOSITION.has(toks[i]!.toLowerCase()) && i > 0) { toks = toks.slice(0, i); break; }
    }
    if (toks.length === before) break;
  }
  return trimPhrase(toks);
}

/** a token that is an amount or a bare numeral, not a name */
const IS_NUMERIC = /^[$€£¥₹]?[\d,.]+[-–—]?$/;

/**
 * `and`/`or` followed by a DETERMINER starts a new noun phrase ("his teeth, and the chews"), while
 * `and` between bare nouns is a compound and must be kept ("flea and tick collar"). The determiner
 * is the whole signal, and it is the only cheap one there is.
 */
function cutAtNewPhrase(tokens: string[]): string[] {
  for (let i = tokens.length - 2; i >= 0; i--) {
    const w = tokens[i]!.toLowerCase();
    if ((w === 'and' || w === 'or' || w === 'but') && LEADING.has(tokens[i + 1]!.toLowerCase())) {
      return tokens.slice(i + 2);
    }
  }
  return tokens;
}

function trimPhrase(tokens: string[]): string {
  let toks = cutAtNewPhrase(tokens).slice(-MAX_NP_TOKENS);
  while (toks.length > 0 && LEADING.has(toks[0]!.toLowerCase())) toks = toks.slice(1);
  // list markers and stray numerals ("1. Dog bed: $40") are not part of the name
  while (toks.length > 0 && !/[a-z]/i.test(toks[0]!)) toks = toks.slice(1);
  while (toks.length > 0 && CONNECTOR.has(toks[toks.length - 1]!.toLowerCase())) toks.pop();
  if (toks.length === 0) return '';
  // a phrase made only of digits/punctuation carries no retrieval signal
  if (!toks.some((t) => /[a-z]{2}/i.test(t))) return '';
  return toks.join(' ');
}

/**
 * Normalized attribute suffix for a noun phrase: `flea and tick collar` → `flea_tick_collar`.
 * Function words are dropped so the slug is made of the tokens a question would actually carry.
 */
export function slugOf(np: string): string {
  const toks = np
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && !LEADING.has(t))
    .slice(-3);
  return toks.join('_').slice(0, 48);
}

// ---------------------------------------------------------------------------------------------
// enumerated lists
// ---------------------------------------------------------------------------------------------

const LIST_ITEM_RE = /^\s{0,8}(?:([-*•+])|(\d{1,2})[.)])\s+(\S.*?)\s*$/;

export interface ListItem {
  /** the printed number for a numbered list; 1-based position for a bulleted one */
  index: number;
  text: string;
  /** 0-based line number in the turn, for the evidence span */
  line: number;
}
export interface ParsedList {
  /** the line that introduces the list, cleaned of markdown, or '' */
  leadIn: string;
  items: ListItem[];
}

function cleanLine(s: string): string {
  return s.replace(/[*_#`]+/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Every enumerated list in a turn. A list is a run of item lines with at most one blank line
 * between them, and needs at least two items — a lone bullet is a sentence with a dash.
 *
 * Items keep their PRINTED number, because that is what "the 7th job in the list you gave me"
 * refers to. Bulleted lists get their 1-based position instead.
 */
export function parseLists(text: string): ParsedList[] {
  const lines = text.split('\n');
  const lists: ParsedList[] = [];
  let cur: ListItem[] = [];
  let bulletPos = 0;
  let leadIn = '';
  let lastNonList = '';
  let gap = 0;

  const flush = (): void => {
    if (cur.length >= 2) lists.push({ leadIn, items: cur });
    cur = [];
    bulletPos = 0;
  };

  for (const [i, raw] of lines.entries()) {
    const m = LIST_ITEM_RE.exec(raw);
    if (m) {
      if (cur.length === 0) leadIn = cleanLine(lastNonList).replace(/[:：]\s*$/, '').slice(0, 100);
      gap = 0;
      const index = m[2] ? Number(m[2]) : ++bulletPos;
      cur.push({ index, text: cleanLine(m[3]!), line: i });
      continue;
    }
    if (raw.trim() === '') {
      gap++;
      if (gap > 1) flush();
      continue;
    }
    flush();
    lastNonList = raw;
    gap = 0;
  }
  flush();
  return lists;
}

// ---------------------------------------------------------------------------------------------
// the pass
// ---------------------------------------------------------------------------------------------

interface Occupied { from: number; to: number }
function overlaps(spans: Occupied[], from: number, to: number): boolean {
  return spans.some((s) => from < s.to && s.from < to);
}

interface TurnCtx {
  turn: Turn;
  sessionOrdinal: number;
  anchorIso: string;
}

/** All typed claims from ONE turn. Pure; the caller supplies the session anchor. */
export function extractTypedFromTurn(ctx: TurnCtx, opts: TypedOptions = {}): TypedClaim[] {
  const maxListItems = opts.maxListItems ?? DEFAULTS.maxListItems;
  const maxClaims = opts.maxClaimsPerTurn ?? DEFAULTS.maxClaimsPerTurn;
  const wanted = new Set(opts.families ?? ALL_FAMILIES);
  const text = ctx.turn.text;
  const masked = maskCode(text);
  const out: TypedClaim[] = [];
  const taken: Occupied[] = [];

  const push = (
    family: TypedFamily,
    subject: string,
    attribute: string,
    value: string,
    evidence: string,
    confidence: number,
    eventTimeIso = '',
    // How the absolute time was arrived at. A date written in the turn is EXPLICIT; a date COMPUTED
    // from "three months ago" plus the session anchor is RELATIVE, and saying so is the difference
    // between a quoted fact and a derived one.
    timeBasis: TimeBasis = 'EXPLICIT',
  ): void => {
    out.push({
      family,
      resolved: eventTimeIso !== '',
      subject,
      attribute,
      value,
      polarity: 'AFFIRM',
      eventTimeIso,
      timeBasisHint: timeBasis,
      extractorModel: TYPED_MODEL,
      sessionId: ctx.turn.sessionId,
      sessionOrdinal: ctx.sessionOrdinal,
      turnIdx: ctx.turn.turnIdx,
      evidenceSpan: span(evidence),
      confidence,
    });
  };

  // A disabled family also stops claiming character ranges, so "three months ago" falls through to
  // `duration` when `relative_time` is off rather than vanishing.
  const scan = (family: TypedFamily, re: RegExp, fn: (m: RegExpExecArray) => void): void => {
    if (!wanted.has(family)) return;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      const from = m.index;
      const to = m.index + m[0].length;
      if (overlaps(taken, from, to)) continue;
      taken.push({ from, to });
      fn(m);
      if (out.length >= maxClaims) return;
    }
  };

  const evidenceFor = (from: number, to: number): string => {
    const b = sentenceAround(text, from, to);
    return text.slice(b.from, b.to);
  };

  // Order matters: the longest, most specific families claim their character ranges first, so
  // "three months ago" is a relative time and never also a bare "three months" duration.

  // (1) absolute dates
  scan('date', DATE_RE, (m) => {
    const verbatim = text.slice(m.index, m.index + m[0].length);
    const iso = resolveAbsoluteDate(verbatim);
    push('date', 'the user', `${TYPED_PREFIX}date`, verbatim, evidenceFor(m.index, m.index + m[0].length), iso ? 0.65 : 0.55, iso);
  });

  // (2) relative time — normalized against the session anchor when the offset is exact
  scan('relative_time', RELATIVE_RE, (m) => {
    const verbatim = text.slice(m.index, m.index + m[0].length);
    const iso = resolveRelative(verbatim, ctx.anchorIso);
    push('relative_time', 'the user', `${TYPED_PREFIX}relative_time`, verbatim, evidenceFor(m.index, m.index + m[0].length), iso ? 0.6 : 0.5, iso, 'RELATIVE');
  });

  // (3) durations — a length of time, not a point in it; never normalized to a date
  scan('duration', DURATION_RE, (m) => {
    const verbatim = text.slice(m.index, m.index + m[0].length);
    push('duration', 'the user', `${TYPED_PREFIX}duration`, verbatim, evidenceFor(m.index, m.index + m[0].length), 0.55);
  });

  // (4) clock times
  scan('time', TIME_RE, (m) => {
    const verbatim = text.slice(m.index, m.index + m[0].length);
    push('time', 'the user', `${TYPED_PREFIX}time`, verbatim, evidenceFor(m.index, m.index + m[0].length), 0.55);
  });

  // (5) money — the family the 85fa3a3f defect is made of
  scan('money', MONEY_RE, (m) => {
    const from = m.index;
    const to = m.index + m[0].length;
    const verbatim = text.slice(from, to);
    const np = localNounPhrase(text, from, to);
    const slug = np ? slugOf(np) : '';
    push(
      'money',
      np || 'the user',
      slug ? `${TYPED_PREFIX}money_${slug}` : `${TYPED_PREFIX}money_amount`,
      verbatim,
      evidenceFor(from, to),
      slug ? 0.65 : 0.5,
    );
  });

  // (6) enumerated lists — one claim per item, indexed by the PRINTED number
  const lines = text.split('\n');
  for (const list of wanted.has('list_item') ? parseLists(masked) : []) {
    const subject = list.leadIn || 'the list';
    for (const item of list.items.slice(0, maxListItems)) {
      if (out.length >= maxClaims) break;
      const verbatim = cleanLine(lines[item.line] ?? item.text);
      if (!item.text) continue;
      push('list_item', subject, `${TYPED_PREFIX}list_item_${item.index}`, span(item.text), verbatim, 0.7);
    }
  }

  return out.slice(0, maxClaims);
}

/**
 * The typed pass over a WHOLE history — every session, every turn, both roles, NO salience gate.
 * Duplicate (subject, attribute, value, turn) tuples are collapsed: they would mint the same claim
 * key and MERGE onto one vertex anyway, and two identical rows in one batch is an idempotency-key
 * conflict HydraDB rejects.
 */
export function extractTyped(history: History, opts: TypedOptions = {}): TypedClaim[] {
  const out: TypedClaim[] = [];
  const seen = new Set<string>();
  for (const session of history.sessions) {
    for (const turn of session.turns) {
      const claims = extractTypedFromTurn(
        { turn, sessionOrdinal: session.ordinal, anchorIso: session.dateIso },
        opts,
      );
      for (const c of claims) {
        const k = `${session.ordinal} ${c.turnIdx} ${c.subject} ${c.attribute} ${c.value}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(c);
      }
    }
  }
  return out;
}

/** Per-family counts for the dry run (`extracted` / `resolved` / distinct attributes). */
export function summarizeTyped(claims: readonly TypedClaim[]): Record<TypedFamily, { claims: number; resolved: number; attributes: number }> {
  const families: TypedFamily[] = ['money', 'duration', 'relative_time', 'date', 'time', 'list_item'];
  const out = {} as Record<TypedFamily, { claims: number; resolved: number; attributes: number }>;
  for (const f of families) {
    const rows = claims.filter((c) => c.family === f);
    out[f] = {
      claims: rows.length,
      resolved: rows.filter((c) => c.resolved).length,
      attributes: new Set(rows.map((c) => c.attribute)).size,
    };
  }
  return out;
}

/** The typed pass behind the shared `Extractor` interface, so the write path is unchanged. */
export class TypedExtractor implements Extractor {
  readonly model = TYPED_MODEL;
  private readonly opts: TypedOptions;
  constructor(opts: TypedOptions = {}) {
    this.opts = opts;
  }
  async extract(history: History): Promise<ExtractedClaim[]> {
    return extractTyped(history, this.opts);
  }
}

/**
 * Run several extractors over the same history and concatenate their claims.
 *
 * This is safe precisely because the graph already treats extractors as additive: claim ids are a
 * pure function of (history, subject, attribute, value, position), so where two passes agree they
 * MERGE onto one vertex, and where they disagree they coexist under MULTI arity. Each claim keeps
 * its own `extractor_model` tag, so the union is auditable and filterable after the fact.
 */
export class UnionExtractor implements Extractor {
  readonly model: string;
  private readonly parts: readonly Extractor[];
  constructor(parts: readonly Extractor[]) {
    this.parts = parts;
    this.model = parts.map((p) => p.model).join('+');
  }
  async extract(history: History): Promise<ExtractedClaim[]> {
    const results = await Promise.all(this.parts.map(async (p) => (await p.extract(history)).map((c) => ({ extractorModel: p.model, ...c }))));
    return results.flat();
  }
}
