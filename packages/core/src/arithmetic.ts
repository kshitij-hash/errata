// packages/core/src/arithmetic.ts — the deterministic ARITHMETIC layer of the answer path.
//
// WHY THIS EXISTS
// ---------------
// The typed-fact experiment (rejected, see eval/RESULTS.md) was aimed at a hypothesis that turned
// out to be wrong, and in being wrong it produced the diagnosis this module answers. On history
// `85fa3a3f` the question is the total of four purchases — food bowl $15, measuring cup $5, dental
// chews $10, flea-and-tick collar $20, gold `$50`. All four amounts were in the graph, all four
// REACHED the synthesis window, and the model answered **$45**. Nothing was missing: the reader
// simply added four small numbers wrong.
//
// That is the same shape as the temporal finding — a computation the graph can do exactly, left to
// a token predictor that does it approximately — so it gets the same treatment. A cheap lexical
// probe decides whether the question asks for a total; the code then sums the amounts it can read
// out of the retrieved material and injects the result into the MATERIAL. The answer prompt
// (sha a1ea7ee7…) does not move; nothing here calls a model.
//
// THE COUNTING TRAP, AND WHY THE SUM IS OVER *DISTINCT* AMOUNTS
// ------------------------------------------------------------
// Claims are heavily restated: the flagship's four purchases arrive as EIGHT claims, because the
// same figure is extracted under several attribute names and quoted from several turns ("Flea and
// tick collar: $20 (one-time expense)" and "I forgot to mention I also got a flea and tick collar…
// which was $20"). Summing every claim gives $80, not $50 — confidently, and wrongly.
//
// So the sum is taken over amounts DEDUPLICATED BY VALUE within a currency. That is the right bias
// for this corpus: restatement is common and two genuinely different items sharing an exact price
// is rare. It is also a real limitation rather than a hidden one, so the rendered block says which
// amounts were folded together and how many times each was mentioned, and the itemisation carries
// citations so a reader can check the arithmetic rather than trust it.

import { lexTokens } from './lexical.js';

const CURRENCY_SYMBOL: Readonly<Record<string, string>> = {
  $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY',
};

/**
 * Words that carry no identity when matching an enumerated item to a claim. "new", "cost" and
 * "monthly" appear in half the money claims of a shopping history, so letting them count towards
 * the match makes every item match everything.
 */
const GENERIC = new Set([
  'new', 'cost', 'costs', 'price', 'priced', 'total', 'monthly', 'month', 'year', 'week', 'daily',
  'one', 'time', 'expense', 'purchase', 'purchased', 'bought', 'buy', 'got', 'get', 'pay', 'paid',
  'spend', 'spent', 'about', 'around', 'approximately', 'per', 'each', 'item', 'items', 'thing',
]);

// Same vocabulary as the ask path's lexical canonicalization, kept local so this module stays a
// leaf with no import of the ranker's internals.
const CURRENCY_WORD: Readonly<Record<string, string>> = {
  usd: 'USD', dollar: 'USD', dollars: 'USD', buck: 'USD', bucks: 'USD',
  eur: 'EUR', euro: 'EUR', euros: 'EUR',
  gbp: 'GBP', pound: 'GBP', pounds: 'GBP',
  jpy: 'JPY', yen: 'JPY',
  cad: 'CAD', aud: 'AUD', chf: 'CHF', inr: 'INR', rupee: 'INR', rupees: 'INR',
};

/**
 * Does this question ask for a total?
 *
 * Narrow on purpose. A false positive spends a few dozen tokens on a sum nobody asked for; but a
 * sum injected into a question that wanted a single value is an active distractor, which is worse
 * than silence. So the probe requires an explicit aggregation word.
 */
// NOTE the deliberate absence of a bare `how much was/is/did`. That form is the single-value
// question, not the aggregate one — "How much was I pre-approved for by Wells Fargo?" is the
// flagship demo question, and firing on it would inject a sum into the one ask that must stay a
// single struck-and-superseded figure. An aggregation needs an aggregation word, or a spend verb.
const TOTAL_PROBE =
  /\b(?:in\s+total|total(?:ly)?|altogether|all\s+together|combined|overall\s+cost|sum\s+of|how\s+much\s+\w[\w\s,'-]{0,40}?\b(?:spend|spent|cost|costs|pay|paid|come\s+to))\b/i;

export interface ArithmeticSignal {
  total: boolean;
}

export function arithmeticIntent(question: string): ArithmeticSignal {
  return { total: TOTAL_PROBE.test(question) };
}

/** One claim, reduced to what the sum needs. */
export interface AmountClaim {
  attribute: string;
  value: string;
  sessionId: string;
  turnIndex: number;
}

export interface ParsedAmount {
  amount: number;
  currency: string;
}

/**
 * Read every currency-marked amount out of a text.
 *
 * Currency-MARKED is the whole discipline here: a bare number in a claim value is far more likely
 * to be a year, a count, a duration or a time ("5 years", "7:30 AM", "3 classes") than money, and
 * summing those produces a confident number with no meaning. `$5`, `5 dollars` and `5 USD` are
 * money; `5` on its own is not, and is reported as unsummable instead of guessed at.
 */
export function parseAmounts(text: string): ParsedAmount[] {
  const out: ParsedAmount[] = [];
  const seen = new Set<number>(); // character offsets already consumed
  const s = text;

  // symbol-prefixed: $1,250.50
  const symRe = /([$€£¥])\s*(\d[\d,]*(?:\.\d+)?)/g;
  for (let m = symRe.exec(s); m !== null; m = symRe.exec(s)) {
    const cur = CURRENCY_SYMBOL[m[1]!];
    const n = Number(m[2]!.replace(/,/g, ''));
    if (cur && Number.isFinite(n)) {
      out.push({ amount: n, currency: cur });
      for (let i = m.index; i < m.index + m[0].length; i++) seen.add(i);
    }
  }
  // word-suffixed: 1,250 dollars / 20 USD
  const wordRe = /(\d[\d,]*(?:\.\d+)?)\s*([a-zA-Z]{3,7})\b/g;
  for (let m = wordRe.exec(s); m !== null; m = wordRe.exec(s)) {
    if (seen.has(m.index)) continue;
    const cur = CURRENCY_WORD[m[2]!.toLowerCase()];
    const n = Number(m[1]!.replace(/,/g, ''));
    if (cur && Number.isFinite(n)) out.push({ amount: n, currency: cur });
  }
  return out;
}

/**
 * The item phrases a question enumerates: "the total cost of the new food bowl, measuring cup,
 * dental chews, and flea and tick collar" → ["new food bowl", "measuring cup", "dental chews",
 * "flea tick collar"].
 *
 * THIS IS THE LOAD-BEARING PART, and it is why there is no window-wide sum. Ordering every dated
 * claim is always valid — the ordinals and gaps are true whichever subset the question wanted. A
 * SUM is not like that: it asserts a subset, and on the flagship the window holds seven amounts
 * (a dog bed, a month of kibble and a $1,500 watch alongside the four items asked about) whose
 * blind total is $1,640. Worse, relevance does not separate them — the last wanted item scores
 * 0.1958 and the first unwanted one 0.1874, a gap of 0.008, which is noise. So the subset comes
 * from the question's own enumeration or there is no sum at all.
 */
export function enumeratedItems(question: string): string[] {
  // drop the interrogative head up to the first "of"/"for" so "what is the total cost of" goes away
  const body = question.replace(/^[^,]*?\b(?:cost|price|total|spend|spent|pay|paid)\b\s*(?:of|for|on)\s*/i, '');
  // Commas delimit the list when there are any; "and" is then only the Oxford conjunction on the
  // final element and is stripped, NOT split on. Splitting every "and" tears multi-word item names
  // in half — "flea and tick collar" becomes "flea" + "tick collar", each of which then matches a
  // different restatement of the SAME $20 claim and the collar gets counted twice.
  const parts = body.includes(',') ? body.split(',') : body.split(/\band\b/i);
  return parts
    .map((p) => p.replace(/[?.!]/g, '').replace(/^\s*and\s+/i, '').trim())
    .filter((p) => p.length > 0);
}

/** One distinct amount, with the claims that mentioned it. */
export interface AmountLine {
  amount: number;
  currency: string;
  label: string;
  /** the claim value this amount was read out of — matched against the question's item phrases */
  text: string;
  sessionId: string;
  turnIndex: number;
  /** how many separate claims in the material carried this same figure */
  mentions: number;
}

export interface TotalsResult {
  /** per currency, the distinct amounts in ascending order */
  byCurrency: Map<string, AmountLine[]>;
  /** per currency, the sum of those distinct amounts */
  sums: Map<string, number>;
  /** claims in the material carrying no readable amount — counted, never summed */
  unsummable: number;
  /** the question's enumerated items that were matched to an amount, in question order */
  matched: { item: string; line: AmountLine }[];
  /** enumerated items the material had no amount for — disclosed, never silently dropped */
  unmatched: string[];
  /** sum over `matched` only, per currency. Empty unless the question enumerated ≥2 matched items */
  matchedSums: Map<string, number>;
}

/**
 * Fold the material's claims into per-currency totals over DISTINCT amounts (see the header note
 * on restatement). Ties keep the caller's original order, so the result is a pure function of the
 * rows and two identical asks render identical text.
 */
export function computeTotals(claims: readonly AmountClaim[], question = ''): TotalsResult {
  const byCurrency = new Map<string, Map<number, AmountLine>>();
  /** one record per (claim, amount) — the un-deduplicated view the item matcher needs */
  const entries: AmountLine[] = [];
  let unsummable = 0;

  for (const c of claims) {
    const amounts = parseAmounts(c.value);
    if (amounts.length === 0) {
      unsummable++;
      continue;
    }
    for (const { amount, currency } of amounts) {
      entries.push({
        amount,
        currency,
        label: c.attribute.replace(/_/g, ' '),
        text: c.value,
        sessionId: c.sessionId,
        turnIndex: c.turnIndex,
        mentions: 1,
      });
      let bucket = byCurrency.get(currency);
      if (!bucket) {
        bucket = new Map<number, AmountLine>();
        byCurrency.set(currency, bucket);
      }
      const hit = bucket.get(amount);
      if (hit) {
        hit.mentions++;
      } else {
        bucket.set(amount, {
          amount,
          currency,
          label: c.attribute.replace(/_/g, ' '),
          text: c.value,
          sessionId: c.sessionId,
          turnIndex: c.turnIndex,
          mentions: 1,
        });
      }
    }
  }

  const lines = new Map<string, AmountLine[]>();
  const sums = new Map<string, number>();
  for (const [cur, bucket] of byCurrency) {
    const sorted = [...bucket.values()].sort((a, b) => a.amount - b.amount);
    lines.set(cur, sorted);
    sums.set(cur, +sorted.reduce((t, l) => t + l.amount, 0).toFixed(2));
  }

  // ---- match the question's enumerated items to amounts -----------------------------------
  // Matching runs over CLAIMS, not over the deduplicated amounts above. Two genuinely different
  // items that happen to cost the same ($15 bowl, $15 cup) are one line in the display list but
  // two claims here, so the total is $30 and not $15 — deduplication is a display concern and must
  // not silently delete an addend. One claim can answer only one named item, and each item takes
  // its single best claim, which is also what collapses a figure restated across several claims.
  const matched: { item: string; line: AmountLine }[] = [];
  const unmatched: string[] = [];
  const matchedSums = new Map<string, number>();
  const items = enumeratedItems(question);
  if (items.length >= 2) {
    const usedClaims = new Set<number>();
    for (const item of items) {
      const want = lexTokens(item).filter((t) => !GENERIC.has(t));
      if (want.length === 0) continue;
      let best: { idx: number; line: AmountLine } | undefined;
      let bestCov = 0;
      entries.forEach((e, idx) => {
        if (usedClaims.has(idx)) return;
        const have = new Set(lexTokens(`${e.label} ${e.text}`));
        const cov = want.filter((t) => have.has(t)).length / want.length;
        if (cov > bestCov) {
          bestCov = cov;
          best = { idx, line: e };
        }
      });
      // half the item's distinctive words must actually appear, or it is not that item
      if (best && bestCov >= 0.5) {
        matched.push({ item, line: best.line });
        usedClaims.add(best.idx);
      } else {
        unmatched.push(item);
      }
    }
    if (matched.length >= 2) {
      for (const { line } of matched) {
        matchedSums.set(line.currency, +((matchedSums.get(line.currency) ?? 0) + line.amount).toFixed(2));
      }
    }
  }

  return { byCurrency: lines, sums, unsummable, matched, unmatched, matchedSums };
}

/** `1234.5` → `1,234.50`; `50` → `50`. Trailing `.00` is dropped — nobody writes "$50.00" here. */
export function formatAmount(n: number, currency: string): string {
  const fixed = Number.isInteger(n) ? String(n) : n.toFixed(2);
  const [whole, frac] = fixed.split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency === 'JPY' ? '¥' : '';
  const body = frac ? `${grouped}.${frac}` : grouped;
  return sym ? `${sym}${body}` : `${body} ${currency}`;
}

/**
 * Print the totals as a block for the MATERIAL.
 *
 * Renders NOTHING when no currency has at least two distinct amounts: one amount is not a total,
 * and a block that restates a single figure as its own sum is noise that can only mislead. Each
 * currency is summed separately and never across — a USD total and a EUR total are two answers,
 * and silently adding them would be exactly the kind of confident nonsense this layer removes.
 */
export function renderTotals(t: TotalsResult): string {
  const currencies = [...t.byCurrency.entries()].filter(([, lines]) => lines.length >= 2);
  if (currencies.length === 0) return '';
  currencies.sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const out: string[] = ['--- COMPUTED AMOUNTS (read from the material above; the same figure restated in several claims is counted ONCE) ---'];
  for (const [cur, lines] of currencies) {
    for (const l of lines) {
      const restated = l.mentions > 1 ? ` [stated in ${l.mentions} claims]` : '';
      out.push(`  ${formatAmount(l.amount, cur)} — ${l.label} (session ${l.sessionId}, turn ${l.turnIndex})${restated}`);
    }
  }
  if (t.unsummable > 0) {
    out.push(`${t.unsummable} claim(s) above carry no readable currency amount.`);
  }

  // The sum is published ONLY for the items the question itself enumerated. A total over every
  // amount in the window would answer a question nobody asked — see `enumeratedItems`.
  if (t.matchedSums.size > 0) {
    out.push('');
    out.push('The question names these items; each was matched to one amount above:');
    for (const { item, line } of t.matched) {
      out.push(`  "${item}" → ${formatAmount(line.amount, line.currency)} (${line.label})`);
    }
    for (const [cur, sum] of [...t.matchedSums.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const n = t.matched.filter((m) => m.line.currency === cur).length;
      out.push(`TOTAL of the ${n} items the question names = ${formatAmount(sum, cur)}`);
    }
    if (t.unmatched.length > 0) {
      out.push(`No amount was found for: ${t.unmatched.map((u) => `"${u}"`).join(', ')} — so the total above EXCLUDES ${t.unmatched.length === 1 ? 'it' : 'them'}.`);
    }
  }
  out.push('--- END COMPUTED AMOUNTS ---');
  return out.join('\n');
}
