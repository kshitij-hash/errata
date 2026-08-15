// packages/ingest/src/text.ts — deterministic text utilities: normalization, dates, salience.

import type { Turn } from './reader.js';

/** lowercase, strip punctuation to spaces, collapse whitespace, trim. Removes the id delimiter `|`. */
export function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

// attribute cues that make a turn salient (spec 31 §3.2 rule 1)
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

/** Deterministic salience gate (spec 31 §3.2). Target retention 35-45% (measured in G2). */
export function isSalient(turn: Turn, isFirstUserTurnOfSession: boolean): boolean {
  const contentTokens = tokenize(turn.text);
  if (contentTokens.length < 8) return false; // too short to carry a fact

  const cue = CUE.test(turn.text);
  // assistant turns are mostly generated prose — keep only if they restate a user fact (a cue)
  if (turn.role === 'assistant' && !cue) return false;

  if (isFirstUserTurnOfSession && turn.role === 'user') return true;
  if (cue) return true;
  if (NUMERIC.test(turn.text)) return true;
  if (hasProperNounProxy(turn.text)) return true;
  return false;
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
