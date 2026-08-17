// packages/core/src/lexical.ts — the deterministic question↔claim matcher .
//
// The ask path selects which claims become the answer's MATERIAL. Until now it ranked them with
// `tokenF1(question, attribute + " " + value)`: symmetric F1, exact tokens only, and the evidence
// span — the one field that carries the transcript's own wording — was not scored at all. The
// failure taxonomy measured what that costs: on 67 of 150 comparison questions NOT ONE question
// token matched, ~181 claims were reachable, and the 12 that reached the model were therefore in
// arbitrary graph order. 39 of 42 over-abstentions are that window missing the answering claim.
//
// This module is the replacement, and it is deliberately boring: suffix stripping, number/currency/
// date canonicalization, and IDF-weighted coverage over a bag of tokens. No vectors, no embeddings,
// no model — it is a pure function of the question text and the retrieved rows (CONTEXT rule 2).

import { contentTokens } from './evidence.js';

/**
 * Lemma-lite: an ordered cascade of suffix rules, NOT a linguistic stemmer.
 *
 * It exists so `earnings`/`earned`/`earn`, `markets`/`market`, `studies`/`study` collide, which is
 * the whole of what the ask path needs. It is intentionally conservative — short tokens and
 * `ss`/`us`/`is` endings are left alone — because an over-eager stem merges unrelated claims and
 * that shows up as a wrong answer, which is worse than a miss.
 */
export function stem(token: string): string {
  let t = token;
  if (t.length <= 3) return t;
  if (t.endsWith('ies') && t.length > 4) t = `${t.slice(0, -3)}y`;
  else if (/(?:ss|sh|ch|x|z)es$/.test(t)) t = t.slice(0, -2);
  else if (t.endsWith('s') && !/(?:ss|us|is)$/.test(t)) t = t.slice(0, -1);
  if (t.length > 5 && t.endsWith('ing')) t = undouble(t.slice(0, -3));
  else if (t.length > 4 && t.endsWith('ed')) t = undouble(t.slice(0, -2));
  if (t.length > 4 && t.endsWith('ly')) t = t.slice(0, -2);
  return t.length >= 2 ? t : token;
}

/** `runn` → `run`, `stopp` → `stop`; leaves `ll`/`ss`/`ff` (small/pass/staff) alone. */
function undouble(t: string): string {
  const last = t.at(-1);
  if (last !== undefined && last === t.at(-2) && !'lsfzr'.includes(last)) return t.slice(0, -1);
  return t;
}

const MONTHS: Readonly<Record<string, string>> = {
  january: '01', jan: '01', february: '02', feb: '02', march: '03', mar: '03',
  april: '04', apr: '04', may: '05', june: '06', jun: '06', july: '07', jul: '07',
  august: '08', aug: '08', september: '09', sep: '09', sept: '09', october: '10', oct: '10',
  november: '11', nov: '11', december: '12', dec: '12',
};

// Same currency vocabulary as ingest's normValue v2, so a question's `$495` and a claim value
// normalized at write time land on the same pair of tokens (`495`, `usd`).
const CURRENCY_SYMBOL_CODE: Readonly<Record<string, string>> = {
  $: 'usd', '€': 'eur', '£': 'gbp', '¥': 'jpy',
};
const CURRENCY_WORD: Readonly<Record<string, string>> = {
  usd: 'usd', dollar: 'usd', dollars: 'usd', buck: 'usd', bucks: 'usd',
  eur: 'eur', euro: 'eur', euros: 'eur',
  gbp: 'gbp', pound: 'gbp', pounds: 'gbp',
  jpy: 'jpy', yen: 'jpy',
  cad: 'cad', aud: 'aud', chf: 'chf', inr: 'inr', rupee: 'inr', rupees: 'inr',
};

/**
 * Canonicalize the numeric surface of a text BEFORE tokenization, matching normValue v2's shape.
 *
 * - `400,000` → `400000` (a thousands separator is punctuation, not a token boundary)
 * - `$495` → `495 usd`, `495 dollars` → `495 usd`
 * - `2023-08-11`, `2023/08/11`, `August 11, 2023`, `11 August 2023` → `2023 08 11`
 * - a bare month name → its two-digit number as an EXTRA token (the word is kept too)
 */
export function canonicalizeNumbers(text: string): string {
  let s = text.toLowerCase();
  s = s.replace(/(\d),(?=\d{3}\b)/g, '$1'); // 400,000 → 400000
  // `$495` → `495 usd`; a symbol with no amount behind it is just a separator.
  s = s.replace(/([$€£¥])\s*(\d+(?:\.\d+)?)/g, (_m, sym: string, n: string) => `${n} ${CURRENCY_SYMBOL_CODE[sym] ?? ''}`);
  s = s.replace(/[$€£¥]/g, ' ');
  s = s.replace(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g, (_m, y: string, mo: string, d: string) => `${y} ${pad(mo)} ${pad(d)}`);
  s = s.replace(
    /\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g,
    (m, mon: string, d: string, y: string) => (MONTHS[mon] ? `${y} ${MONTHS[mon]} ${pad(d)}` : m),
  );
  s = s.replace(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\s+(\d{4})\b/g,
    (m, d: string, mon: string, y: string) => (MONTHS[mon] ? `${y} ${MONTHS[mon]} ${pad(d)}` : m),
  );
  // bare month word → keep the word AND add its number
  s = s.replace(/\b([a-z]{3,9})\b/g, (m) => (MONTHS[m] ? `${m} ${MONTHS[m]}` : m));
  // currency words after a number → the ISO code as well
  s = s.replace(/\b(\d+)\s+([a-z]{3,7})\b/g, (m, n: string, w: string) =>
    CURRENCY_WORD[w] ? `${n} ${CURRENCY_WORD[w]}` : m,
  );
  return s;
}

function pad(v: string): string {
  return v.length === 1 ? `0${v}` : v;
}

/**
 * A hyphenated compound also yields its closed form: `pre-approved` → `pre`, `approved`,
 * `preapproved`. Without it a question that hyphenates cannot meet an attribute that spells the
 * same word closed (`mortgage_preapproval_amount`), which is a spelling accident, not a meaning.
 */
function withClosedCompounds(text: string): string {
  let out = text;
  for (const m of text.matchAll(/([a-z]{2,})-([a-z]{2,})/g)) out += ` ${m[1]}${m[2]}`;
  return out;
}

/** The ask path's token bag: canonicalize numbers, drop stopwords, stem. Order-preserving, deduped. */
export function lexTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of contentTokens(withClosedCompounds(canonicalizeNumbers(text)))) {
    const t = stem(raw);
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** Adjacent token pairs, joined with a space — the n-gram probe for multi-word lexicon entries. */
export function bigrams(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < tokens.length; i++) out.push(`${tokens[i - 1]} ${tokens[i]}`);
  return out;
}

/**
 * IDF over the candidate set itself: ln(1 + N / (1 + df)).
 *
 * The denominator is THIS history's claims, not a global corpus — so a token every claim in the
 * history carries ("user", "prefers") weighs nothing here while a token that appears in two claims
 * dominates. That is the property the ranker needs and it costs one pass over ~200 rows.
 */
export function idfWeights(docs: readonly (readonly string[])[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  const idf = new Map<string, number>();
  for (const [t, c] of df) idf.set(t, Math.log(1 + n / (1 + c)));
  return idf;
}

/** IDF-weighted share of the QUESTION's tokens present in `docTokens` ∈ [0,1]. Asymmetric on
 *  purpose: a long claim is not penalized for being long, only rewarded for covering the ask. */
export function coverage(
  qTokens: readonly string[],
  docTokens: ReadonlySet<string>,
  idf: ReadonlyMap<string, number>,
): number {
  let total = 0;
  let hit = 0;
  for (const t of qTokens) {
    const w = idf.get(t) ?? 1;
    total += w;
    if (docTokens.has(t)) hit += w;
  }
  return total === 0 ? 0 : hit / total;
}

export interface RelevanceDoc {
  /** tokens of the attribute name (plus its write-side aliases) */
  attrTokens: readonly string[];
  /** tokens of attribute + value + evidence span */
  bodyTokens: readonly string[];
}

/** fit = 0.65·coverage(body) + 0.35·coverage(attribute). The attribute term keeps the old
 *  head-noun behaviour ("the amount …" → the amount attribute); the body term is what the
 *  taxonomy showed was missing (the evidence span carries the transcript's own wording). */
export const W_BODY = 0.65;
export const W_ATTR = 0.35;

export function relevance(
  qTokens: readonly string[],
  doc: RelevanceDoc,
  idf: ReadonlyMap<string, number>,
): number {
  const body = coverage(qTokens, new Set(doc.bodyTokens), idf);
  const attr = coverage(qTokens, new Set(doc.attrTokens), idf);
  return W_BODY * body + W_ATTR * attr;
}

/**
 * Rank candidates by `relevance`, keep the top `k`.
 *
 * Ties break by ORIGINAL ORDER, so the result is a pure function of (question, rows) — two
 * identical asks return the identical material, which is what makes the answer reproducible.
 * Candidates that score exactly zero are still returned (up to k) rather than dropped: a question
 * whose vocabulary shares nothing with the history is exactly when the model must see SOMETHING to
 * refuse against, and it is the caller's τ/refusal gate that decides, not the ranker.
 */
export function rankByRelevance<T extends RelevanceDoc>(
  qTokens: readonly string[],
  cands: readonly T[],
  k: number,
): Array<T & { s: number }> {
  const idf = idfWeights(cands.map((c) => c.bodyTokens));
  return cands
    .map((cand, i) => ({ cand, i, s: relevance(qTokens, cand, idf) }))
    .sort((x, y) => (y.s !== x.s ? y.s - x.s : x.i - y.i))
    .slice(0, Math.max(0, k))
    .map(({ cand, s }) => ({ ...cand, s }));
}
