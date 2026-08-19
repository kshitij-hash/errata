/**
 * The published eval, as data.
 *
 * `data/results.json` carries ROWS — one judged row per (question, arm, seed), verbatim from the
 * committed run artifacts — and nothing else. Every score the /results route prints is recomputed
 * here from those rows, so a cell and its drill-down cannot disagree: they are the same arithmetic.
 * `results.spec.ts` asserts the recomputation against the README NUMBERS BLOCK, which is the
 * source of truth; if a future wave moves a number and this file is not regenerated, `pnpm test`
 * fails rather than the page lying.
 *
 * Regenerate: `apps/web/scripts/build-results-bundle.py` (read-only over data-raw/ and eval/out/).
 */
import bundle from '../data/results.json';

export type ArmKey = 'errata' | 'full_context' | 'naive';
export type Verdict = 'CORRECT' | 'INCORRECT' | 'UNPARSEABLE' | null;

export interface Question {
  id: string;
  /** the corpus's own question_type */
  type: string;
  /** the reported ability column; 'abstention' for the 30 gold-abstention questions */
  ability: string;
  abstention: boolean;
  question: string;
  gold: string;
  date: string;
}

export interface Citation {
  s: string;
  t: number;
  q: string;
}

export interface JudgedRow {
  answer: string;
  /** per seed (11/22/33) */
  abstained: boolean[];
  verdicts: Verdict[];
  reason: string;
  tok: number;
  seed_variants?: string[];
  cites?: Citation[];
  conf?: number;
}

export interface JudgeControl {
  id: string;
  kind: 'perturbed' | 'positive';
  family: string;
  verdict: string;
  question: string;
  gold: string;
  answer: string;
  transform: string;
}

interface Bundle {
  provenance: {
    note: string;
    dataset: { repo_id: string; revision: string; file: string; sha256: string };
    sample: string;
    seeds: number[];
    runs: Record<ArmKey, string>;
    answer_model: string;
    answer_prompt_sha: string;
    judge_model: string;
    judge_prompt_sha: string;
  };
  questions: Question[];
  arms: Record<ArmKey, { run: string; rows: Record<string, JudgedRow> }>;
  experiments: Record<string, { all450: number; answered: number; answered_prec: number; ctx_tok: number }>;
  arith_diff: { id: string; before: string; after: string; verdict_before: Verdict; verdict_after: Verdict }[];
  revert_diff_rows: number;
  judge_controls: JudgeControl[];
}

const data = bundle as unknown as Bundle;

export const PROVENANCE = data.provenance;
export const QUESTIONS: Question[] = data.questions;
export const EXPERIMENTS = data.experiments;
export const ARITH_DIFF = data.arith_diff;
export const REVERT_DIFF_ROWS = data.revert_diff_rows;
export const JUDGE_CONTROLS: JudgeControl[] = data.judge_controls;
export const SEEDS = data.provenance.seeds;

const BY_ID = new Map(QUESTIONS.map((q) => [q.id, q]));

export const ARMS: { key: ArmKey; label: string; short: string; run: string }[] = [
  { key: 'errata', label: 'Errata', short: 'errata', run: data.arms.errata.run },
  { key: 'full_context', label: 'Full-context baseline', short: 'full-context', run: data.arms.full_context.run },
  { key: 'naive', label: 'Naive top-k RAG (k=10)', short: 'naive', run: data.arms.naive.run },
];

export function armLabel(arm: ArmKey): string {
  return ARMS.find((a) => a.key === arm)!.label;
}

export function row(arm: ArmKey, id: string): JudgedRow {
  return data.arms[arm].rows[id]!;
}

export function question(id: string): Question {
  return BY_ID.get(id)!;
}

/* ------------------------------------------------------------------ the cuts ---------- */

export type CutKind = 'overall' | 'ability' | 'abstention' | 'type';

export interface Cut {
  slug: string;
  label: string;
  /** the published table's own column head, when it is shorter than the label */
  short?: string;
  kind: CutKind;
  /** the ability / question_type this cut selects */
  key?: string;
  /** how a row is scored in this cut, printed on the drill-down */
  rule: string;
}

/** The five accuracy columns of the published table, then the corpus's own question types. */
export const CUTS: Cut[] = [
  {
    slug: 'overall',
    label: 'Overall',
    kind: 'overall',
    rule: 'accuracy over the 120 non-abstention questions; mean ± sd across seeds 11/22/33',
  },
  {
    slug: 'information-extraction',
    label: 'Information extraction',
    short: 'Info. extraction',
    kind: 'ability',
    key: 'information_extraction',
    rule: 'accuracy over the non-abstention questions of this ability; mean ± sd across seeds 11/22/33',
  },
  {
    slug: 'multi-session',
    label: 'Multi-session',
    kind: 'ability',
    key: 'multi_session',
    rule: 'accuracy over the non-abstention questions of this ability; mean ± sd across seeds 11/22/33',
  },
  {
    slug: 'temporal',
    label: 'Temporal',
    kind: 'ability',
    key: 'temporal',
    rule: 'accuracy over the non-abstention questions of this ability; mean ± sd across seeds 11/22/33',
  },
  {
    slug: 'knowledge-update',
    label: 'Knowledge update',
    kind: 'ability',
    key: 'knowledge_update',
    rule: 'accuracy over the non-abstention questions of this ability; mean ± sd across seeds 11/22/33',
  },
  {
    slug: 'abstention',
    label: 'Abstention',
    kind: 'abstention',
    rule: 'scored deterministically by exact match — the judge never sees these rows. A row is right iff the arm abstained.',
  },
  ...[
    'single-session-user',
    'single-session-assistant',
    'single-session-preference',
    'multi-session',
    'temporal-reasoning',
    'knowledge-update',
  ].map((t): Cut => ({
    slug: `type-${t}`,
    label: t,
    kind: 'type',
    key: t,
    rule: 'the corpus’s own question_type, over all 450 rows — a gold-abstention row is right iff the arm abstained, every other row iff the judge said CORRECT',
  })),
];

export function cut(slug: string): Cut | undefined {
  return CUTS.find((c) => c.slug === slug);
}

/** The ability cut a question is counted in — the drill-down page that carries its row. */
export function cutForQuestion(q: Question): Cut {
  if (q.abstention) return cut('abstention')!;
  return CUTS.find((c) => c.kind === 'ability' && c.key === q.ability)!;
}

export function questionsIn(c: Cut): Question[] {
  switch (c.kind) {
    case 'overall':
      return QUESTIONS.filter((q) => !q.abstention);
    case 'ability':
      return QUESTIONS.filter((q) => q.ability === c.key);
    case 'abstention':
      return QUESTIONS.filter((q) => q.abstention);
    case 'type':
      return QUESTIONS.filter((q) => q.type === c.key);
  }
}

/* ------------------------------------------------------------ the arithmetic ---------- */

/** Is this (question, arm, seed) row right, by the rule its cut is scored under? */
export function isRight(arm: ArmKey, q: Question, seed: number): boolean {
  const r = row(arm, q.id);
  if (q.abstention) return r.abstained[seed] === true;
  return r.verdicts[seed] === 'CORRECT';
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample sd (n−1) — the ± in the published table is provider nondeterminism across seeds. */
function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export interface Cell {
  /** percentage, 0–100 */
  pct: number;
  sd: number;
  /** correct rows / total rows, pooled across the three seeds */
  right: number;
  rows: number;
  questions: number;
}

export function cell(arm: ArmKey, c: Cut): Cell {
  const qs = questionsIn(c);
  const perSeed = SEEDS.map((_, i) => qs.filter((q) => isRight(arm, q, i)).length);
  const right = perSeed.reduce((a, b) => a + b, 0);
  return {
    pct: mean(perSeed.map((n) => (100 * n) / qs.length)),
    sd: sd(perSeed.map((n) => (100 * n) / qs.length)),
    right,
    rows: qs.length * SEEDS.length,
    questions: qs.length,
  };
}

/** Abstention precision / recall, pooled over all 450 rows. Positives = predicted abstain. */
export function abstentionPR(arm: ArmKey): { p: number; r: number; tp: number; fp: number; fn: number } {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const q of QUESTIONS) {
    const r = row(arm, q.id);
    for (let i = 0; i < SEEDS.length; i += 1) {
      const pred = r.abstained[i] === true;
      if (pred && q.abstention) tp += 1;
      else if (pred && !q.abstention) fp += 1;
      else if (!pred && q.abstention) fn += 1;
    }
  }
  return { p: tp / (tp + fp), r: tp / (tp + fn), tp, fp, fn };
}

/** Every one of the 450 rows: gold-abstention right iff abstained, everything else iff CORRECT. */
export function all450(arm: ArmKey): number {
  let n = 0;
  for (const q of QUESTIONS) for (let i = 0; i < SEEDS.length; i += 1) if (isRight(arm, q, i)) n += 1;
  return (100 * n) / (QUESTIONS.length * SEEDS.length);
}

/**
 * Hard rule 3, checked against the eval artifacts rather than asserted: every answer carries a
 * citation. Abstentions are not answers — they carry nearest-miss reasoning instead — so they are
 * counted separately and not claimed.
 */
export function citedAnswers(arm: ArmKey = 'errata'): { answered: number; cited: number; abstained: number } {
  let answered = 0;
  let cited = 0;
  let abstained = 0;
  for (const q of QUESTIONS) {
    const r = row(arm, q.id);
    for (let i = 0; i < SEEDS.length; i += 1) {
      if (r.abstained[i]) abstained += 1;
      else {
        answered += 1;
        if (r.cites && r.cites.length > 0) cited += 1;
      }
    }
  }
  return { answered, cited, abstained };
}

/** Mean prompt tokens per question — the context each arm had to read to answer. */
export function ctxTokens(arm: ArmKey): number {
  return mean(QUESTIONS.map((q) => row(arm, q.id).tok));
}

/* ---------------------------------------------------------------- the τ sweep ---------- */

export const TAU_GRID = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55];
export const TAU_SHIPPED = 0.35;

export interface TauRow {
  tau: number;
  overall: number;
  answered: number;
  answeredPrec: number;
  p: number;
  r: number;
  shipped: boolean;
}

/**
 * τ treated as a veto on the recorded synthesis answers — an answered row whose evidence score E
 * falls below τ becomes an abstention. Deterministic and model-free, which is why the sweep can be
 * recomputed here from the same rows the table is counted from; it reproduces
 * `eval/out/tau-sweep-arith.md` line for line, and the spec asserts that it does.
 */
export function tauSweep(): TauRow[] {
  return TAU_GRID.map((tau) => {
    let right = 0;
    let answered = 0;
    let correctAnswered = 0;
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const q of QUESTIONS) {
      const r = row('errata', q.id);
      for (let i = 0; i < SEEDS.length; i += 1) {
        const vetoed = r.conf !== undefined && r.conf < tau;
        const abstain = r.abstained[i] === true || vetoed;
        if (!abstain) {
          answered += 1;
          if (r.verdicts[i] === 'CORRECT') correctAnswered += 1;
        }
        if (q.abstention) {
          if (abstain) {
            right += 1;
            tp += 1;
          } else fn += 1;
        } else {
          if (abstain) fp += 1;
          else if (r.verdicts[i] === 'CORRECT') right += 1;
        }
      }
    }
    return {
      tau,
      overall: (100 * right) / (QUESTIONS.length * SEEDS.length),
      answered,
      answeredPrec: (100 * correctAnswered) / answered,
      p: tp / (tp + fp),
      r: tp / (tp + fn),
      shipped: tau === TAU_SHIPPED,
    };
  });
}

/* ------------------------------------------------- judge control-set arithmetic -------- */

export const JUDGE_FAMILIES = ['entity-swap', 'value-shift', 'attribution-flip', 'superseded-value', 'topical-filler'];

export interface FamilyStat {
  family: string;
  n: number;
  accepted: number;
  unparseable: number;
  far: number;
  gate: number;
}

/** Family gates as pre-registered in eval/judge-validation.md. */
const FAMILY_GATE: Record<string, number> = {
  'entity-swap': 10,
  'value-shift': 10,
  'attribution-flip': 10,
  'superseded-value': 8,
  'topical-filler': 10,
};

export function judgeFamily(family: string): FamilyStat {
  const rows = JUDGE_CONTROLS.filter((c) => c.kind === 'perturbed' && c.family === family);
  const accepted = rows.filter((c) => c.verdict === 'CORRECT').length;
  return {
    family,
    n: rows.length,
    accepted,
    unparseable: rows.filter((c) => c.verdict === 'UNPARSEABLE').length,
    far: (100 * accepted) / rows.length,
    gate: FAMILY_GATE[family] ?? 10,
  };
}

/** False-accept rate: perturbed negatives the judge called CORRECT. Gate ≤ 10.0%. */
export function judgeFAR(): { pct: number; accepted: number; n: number; unparseable: number } {
  const rows = JUDGE_CONTROLS.filter((c) => c.kind === 'perturbed');
  const accepted = rows.filter((c) => c.verdict === 'CORRECT').length;
  return {
    pct: (100 * accepted) / rows.length,
    accepted,
    n: rows.length,
    unparseable: rows.filter((c) => c.verdict === 'UNPARSEABLE').length,
  };
}

/** False-reject rate: paraphrased golds NOT judged CORRECT. Gate ≤ 15.0%. */
export function judgeFRR(): { pct: number; rejected: number; n: number } {
  const rows = JUDGE_CONTROLS.filter((c) => c.kind === 'positive');
  const rejected = rows.filter((c) => c.verdict !== 'CORRECT').length;
  return { pct: (100 * rejected) / rows.length, rejected, n: rows.length };
}

/* -------------------------------------------------------- published constants ---------- */

/**
 * The two columns that are NOT recomputed from these rows, copied from the README NUMBERS BLOCK
 * verbatim. Errata's $/Q and latency are measured on `rerunF-wave`, the last cold-cache run —
 * `rerunJ-arith` replayed 447 of 450 answers from cache and would flatter both. Nothing here is
 * derived; if the README moves, this moves with it and `results.spec.ts` says so.
 */
export const PUBLISHED = {
  usdPerQ: { errata: '$0.0000', full_context: '$0.0110', naive: '$0.0005' } as Record<ArmKey, string>,
  latency: { errata: '0.26 / 1.28', full_context: '8.00 / 8.68', naive: '0.86 / 1.34' } as Record<ArmKey, string>,
  /** Errata's true $/Q — the column rounds to four decimals. */
  errataUsdExact: '$0.0000257',
  /** README: the table, to one decimal, as published. The spec asserts we recompute each of these. */
  table: {
    errata: {
      overall: 60.0,
      information_extraction: 44.7,
      multi_session: 67.7,
      temporal: 51.5,
      knowledge_update: 94.4,
    },
    full_context: {
      overall: 47.5,
      information_extraction: 80.7,
      multi_session: 35.5,
      temporal: 13.1,
      knowledge_update: 61.1,
    },
    naive: { overall: 45.8, information_extraction: 63.2, multi_session: 29.0, temporal: 21.2, knowledge_update: 83.3 },
  },
  all450: { errata: 66.7, full_context: 54.0, naive: 56.2 } as Record<ArmKey, number>,
  ctxTok: { errata: 2532, full_context: 109943, naive: 4665 } as Record<ArmKey, number>,
  abstention: {
    errata: { p: 0.49, r: 0.93 },
    full_context: { p: 0.58, r: 0.8 },
    naive: { p: 0.41, r: 0.98 },
  } as Record<ArmKey, { p: number; r: number }>,
  /** τ is not fitted; the sweep is flat across this interval (eval/RESULTS.md, rerunJ-arith). */
  tau: { shipped: 0.35, plateau: '66.7 flat across τ ∈ [0.20, 0.35]' },
} as const;

export function pct(x: number, digits = 1): string {
  return x.toFixed(digits);
}

/**
 * The published p50 latency in seconds — the first half of the `p50 / p95` column above, which is
 * itself copied from the README NUMBERS BLOCK. Latency is NOT in `data/results.json` (the judged
 * rows carry tokens, not timings), so it cannot be recomputed here; splitting the published string
 * is the next best thing, because it keeps the README the only place the figure is written down.
 * Verified against the README NUMBERS BLOCK 2026-08-19: Errata 0.26 / 1.28, full-context 8.00 / 8.68.
 */
export function p50(arm: ArmKey): string {
  return PUBLISHED.latency[arm].split(' / ')[0]!;
}

/** How many times faster the p50 is — README: "31× lower p50 latency". */
export function p50Ratio(fast: ArmKey, slow: ArmKey): number {
  return Math.round(Number(p50(slow)) / Number(p50(fast)));
}
