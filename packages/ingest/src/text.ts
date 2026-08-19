// packages/ingest/src/text.ts — deterministic text utilities: normalization, dates, salience.

import type { Turn } from './reader.js';

/**
 * The version of `normText` that claim natural keys are minted under (docs/gauntlets.md G4). It is an INPUT to
 * `keys.claim`, so two claims normalized by different generations of this function can never land
 * on the same vertex, and one claim can never silently split across two.
 *
 * BUMP THIS whenever `normText` or `normValue` changes. A bump re-keys every claim, so it also
 * means a re-ingest.
 *
 * v2 — `normValue` canonicalizes monetary amounts. v1 keyed the demo history's pre-approval on the
 * raw surface form, so the rule extractor's `$400,000` and the LLM extractor's `400000 USD` — the
 * same sentence, the same turn, the same fact — minted two claim vertices, each superseding
 * `$350,000`, and the answer card had to hide one of them (docs/gauntlets.md G4).
 */
export const NORM_VERSION = 2;

/** lowercase, strip punctuation to spaces, collapse whitespace, trim. Removes the id delimiter `|`. */
export function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Currency markers a monetary value can carry. The symbol is read from the RAW string, because
// normText strips punctuation and would otherwise lose the only signal `$400,000` has.
const CURRENCY_SYMBOL: readonly [RegExp, string][] = [
  [/\$/, 'usd'],
  [/€/, 'eur'],
  [/£/, 'gbp'],
  [/¥/, 'jpy'],
];
const WORD_TO_CODE: Readonly<Record<string, string>> = {
  usd: 'usd', dollar: 'usd', dollars: 'usd',
  eur: 'eur', euro: 'eur', euros: 'eur',
  gbp: 'gbp', pound: 'gbp', pounds: 'gbp', 'pound sterling': 'gbp', 'pounds sterling': 'gbp',
  jpy: 'jpy', yen: 'jpy',
  cad: 'cad', aud: 'aud', chf: 'chf',
  inr: 'inr', rupee: 'inr', rupees: 'inr',
};

/**
 * Value normalization for the claim natural key (NORM_VERSION 2).
 *
 * `normText`, then one extra rule: a value that is ONLY a number plus (optionally) a currency
 * marker is canonicalized to `<digits> <iso-code>`. That collapses `$400,000` and `400000 USD` —
 * the same amount written by two extractors — onto one claim vertex, which is what B5 was about.
 *
 * It is deliberately narrow. A value with any other word in it ("about 30", "400000 miles") is
 * left exactly as `normText` produced it, and two amounts in different currencies stay distinct.
 * A bare `400000` with no marker at all also stays distinct from `$400,000`: guessing a currency
 * that the corpus never wrote would be inventing evidence.
 */
export function normValue(s: string): string {
  const base = normText(s);
  if (!base) return base;
  const tokens = base.split(' ');
  const digits: string[] = [];
  const words: string[] = [];
  for (const t of tokens) (/^\d+$/.test(t) ? digits : words).push(t);
  if (digits.length === 0) return base;
  const wordCode = words.length > 0 ? WORD_TO_CODE[words.join(' ')] : '';
  if (words.length > 0 && !wordCode) return base; // not a bare amount — leave it alone
  const symbol = CURRENCY_SYMBOL.find(([re]) => re.test(s))?.[1] ?? '';
  const code = symbol || wordCode || '';
  const amount = digits.join('');
  return code ? `${amount} ${code}` : amount;
}

/** Parse a LongMemEval date like "2023/08/11 (Fri) 00:01" → { iso, epoch(seconds) }. */
export function parseLmeDate(raw: string): { iso: string; epoch: number } {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})(?:\s+\([^)]*\))?(?:\s+(\d{2}):(\d{2}))?/.exec(raw.trim());
  if (!m) return { iso: '', epoch: -1 };
  const [, y, mo, d, hh, mm] = m;
  const iso = `${y}-${mo}-${d}`;
  const epoch = Math.floor(Date.UTC(+y!, +mo! - 1, +d!, hh ? +hh : 0, mm ? +mm : 0) / 1000);
  return { iso, epoch };
}

const STOPWORDS = new Set(
  'the a an and or but if then i you he she it we they my your his her its our their me him them this that these those is are was were be been to of in on at for from by with as into over after before'.split(
    ' ',
  ),
);

// attribute cues that make a turn salient 
const CUE = /\b(i am|i'm|my|we|now|used to|no longer|actually|correction|instead|changed|moved|started|stopped|prefer|switched|got a|got my|bought|pre-approved|approved for)\b/i;
// a date, time expression, or a number with a unit / currency
const NUMERIC = /\b(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}:\d{2}|\$\s?\d|\d+\s?(am|pm|kg|km|lbs|miles|dollars|percent|%|k|years?|months?|days?))\b/i;

export function tokenize(text: string): string[] {
  return normText(text).split(' ').filter(Boolean);
}

/** proper-noun proxy: a capitalized token that is not sentence-initial and not a stopword. */
function hasProperNounProxy(text: string): boolean {
  const words = text.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (/^[A-Z][a-zA-Z]{2,}/.test(w) && !STOPWORDS.has(w.toLowerCase())) return true;
  }
  return false;
}

/**
 * A substantive assistant reply is one long enough to be an ANSWER rather than an acknowledgement.
 * 40 tokens is the elbow in the corpus: below it the turn is "Sure, happy to help!".
 */
export const ASSISTANT_MIN_TOKENS = 40;

/**
 * How many non-cue assistant replies one session may contribute. 1 = the session's MAIN answer.
 *
 * This is a cost dial with a measured setting. Unlimited, salience retention goes 62.5% → 84.3% and
 * a re-extract of the comparison-150 prices at $8.14; at 1 it goes to 70.6% and $4.5, while the
 * share of the corpus's gold assistant-evidence turns that survive the gate goes 5/15 → 9/15.
 * The marginal 2 turns of gold coverage cost $3.60 and were not bought.
 */
export const ASSISTANT_MAX_PER_SESSION = 1;

/**
 * Deterministic salience gate . Target retention 35-45% (measured in G2).
 *
 * G5 — the assistant rule used to be "keep only if it restates a user fact (a CUE)". The failure
 * taxonomy priced that: all 14 `single-session-assistant` questions in the comparison-150 scored
 * 0.0% against 92.9% for both baselines, because the thing being asked about ("the 7th job in the
 * list you gave me", "the move after 27. Kg2") was said BY THE ASSISTANT and never reached the
 * extractor at all. A substantive assistant reply to a salient user turn is now salient too: it is
 * the answer half of an exchange the user later asks back about.
 */
export function isSalient(
  turn: Turn,
  isFirstUserTurnOfSession: boolean,
  followsSalientUserTurn = false,
): boolean {
  const contentTokens = tokenize(turn.text);
  if (contentTokens.length < 8) return false; // too short to carry a fact

  const cue = CUE.test(turn.text);
  if (turn.role === 'assistant') {
    if (cue) return true; // restates a user fact
    return followsSalientUserTurn && contentTokens.length >= ASSISTANT_MIN_TOKENS;
  }

  if (isFirstUserTurnOfSession) return true;
  if (cue) return true;
  if (NUMERIC.test(turn.text)) return true;
  if (hasProperNounProxy(turn.text)) return true;
  return false;
}

/**
 * Salience for a whole session, in order — the ONE place the `followsSalientUserTurn` state lives,
 * so the structural pass, the rule extractor and the LLM extractor cannot disagree about which
 * turns are salient (they would silently write claims citing turns marked `salient=false`).
 */
export function sessionSalience(turns: readonly Turn[]): boolean[] {
  const out: boolean[] = [];
  let firstUser = true;
  let prevUserSalient = false;
  let assistantKept = 0;
  for (const turn of turns) {
    const isFirstUser = firstUser && turn.role === 'user';
    if (turn.role === 'user') firstUser = false;
    const budget = assistantKept < ASSISTANT_MAX_PER_SESSION;
    const salient = isSalient(turn, isFirstUser, prevUserSalient && budget);
    if (turn.role === 'user') prevUserSalient = salient;
    else if (salient && !CUE.test(turn.text)) assistantKept++;
    out.push(salient);
  }
  return out;
}

/** epoch seconds → 'YYYY-MM-DD'. */
export function epochToIso(epoch: number): string {
  if (epoch < 0) return '';
  const d = new Date(epoch * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** epoch seconds for an ISO 'YYYY-MM-DD', or -1. */
export function isoToEpoch(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return -1;
  return Math.floor(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) / 1000);
}
