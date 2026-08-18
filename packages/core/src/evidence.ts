// packages/core/src/evidence.ts — deterministic evidence score + abstention decision.
//
// The calibrated refusal is a first-class result (CONTEXT the eval protocol). Its confidence must be a number we
// can defend from the response payload, not an LLM self-report . No embeddings, no LLM.

import type { AnswerDecision, EvidenceScore } from './types.js';

// Weights are FIXED a priori (evidence-scoring design). tau is the one free quantity — and it is
// NOT fitted: LongMemEval's 30 abstention questions are all inside the comparison set by design
// (`sample.abstention_whole`), so no held-out slice exists on which it could honestly be fitted.
// tau stays at its a-priori 0.35 and eval/tau_sweep.py publishes the sensitivity instead
// (eval/RESULTS.md, "τ was NOT re-fitted, deliberately").
const W = { a: 0.3, s: 0.3, c: 0.15, p: 0.15, d: 0.1 } as const;

const STOPWORDS = new Set(
  ('a an the of to in on at for from by with about as into over after before is are was were be been ' +
    'do did does what when where which who whom whose why how i you he she it we they my your his her ' +
    'its our their me him them and or but if then than that this these those there here have has had ' +
    'will would can could should may might must not no yes do you did i my me').split(/\s+/),
);

/** question/claim text → lowercased content tokens (alphanumeric, stopwords + short tokens dropped). */
export function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** token-level F1 between two token bags (set semantics). */
export function tokenF1(aTokens: string[], bTokens: string[]): number {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  if (inter === 0) return 0;
  const precision = inter / b.size;
  const recall = inter / a.size;
  return (2 * precision * recall) / (precision + recall);
}

export interface QuestionFeatures {
  /** the question's content tokens */
  contentTokens: string[];
  /** how many content tokens resolved to an Entity present in this history */
  anchorsResolved: number;
  hasTimeConstraint: boolean;
  /** only meaningful when hasTimeConstraint: the retrieved belief's event_time violates it */
  timeConstraintViolated: boolean;
}

export interface ScoredClaim {
  attribute: string;
  value: string; // value_text
  registryMatched: boolean;
  /** the caller's own question↔claim relevance ∈ [0,1]. When present it IS `s` — the ask path
   *  already computed it with the full scorer (core/lexical.ts: span-aware, stemmed, IDF-weighted)
   *  and recomputing a token-F1 here would report a different, worse number than the one that
   *  actually selected the claim. Absent → the legacy token-F1 fallback below. */
  fit?: number;
  headConfidence: number; // 0..1
  judgeConfidence: number; // 1.0 when unjudged-and-uncontested
  corroboration: number; // distinct citing turns
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Compute the five-component evidence score E ∈ [0,1] (evidence-scoring design). */
export function scoreEvidence(q: QuestionFeatures, cands: ScoredClaim[], tau: number): EvidenceScore {
  const a = q.contentTokens.length === 0 ? 0 : clamp01(q.anchorsResolved / q.contentTokens.length);

  let s = 0;
  let best: ScoredClaim | null = null;
  for (const cand of cands) {
    const fit =
      cand.fit ??
      tokenF1(q.contentTokens, contentTokens(`${cand.attribute} ${cand.value}`)) *
        (cand.registryMatched ? 1.0 : 0.7);
    if (fit >= s) {
      s = fit;
      best = cand;
    }
  }
  s = clamp01(s);

  const c = best ? clamp01(best.headConfidence * best.judgeConfidence) : 0;
  const p = best ? clamp01(Math.min(best.corroboration, 3) / 3) : 0;
  const d = q.hasTimeConstraint ? (q.timeConstraintViolated ? 0 : 1) : 0.5;

  const E = clamp01(W.a * a + W.s * s + W.c * c + W.p * p + W.d * d);
  return { a, s, c, p, d, E, tau };
}

/** ANSWER if E ≥ τ; DISPUTED if E ≥ τ but the belief is disputed; else ABSTAIN. */
export function decide(score: EvidenceScore, tau: number, disputed = false): AnswerDecision {
  if (score.E >= tau) return disputed ? 'DISPUTED' : 'ANSWER';
  return 'ABSTAIN';
}

/** Rank claims by fit for nearest-miss citations on an abstention .
 *  Stable, returns at most `k`, each item carries its `s` value. */
export function rankClaimsByFit<T extends { attribute: string; value: string; registryMatched: boolean }>(
  qTokens: string[],
  cands: readonly T[],
  k = 3,
): Array<T & { s: number }> {
  return cands
    .map((cand, i) => ({
      cand,
      i,
      s: tokenF1(qTokens, contentTokens(`${cand.attribute} ${cand.value}`)) * (cand.registryMatched ? 1.0 : 0.7),
    }))
    .sort((x, y) => (y.s !== x.s ? y.s - x.s : x.i - y.i)) // fit desc, original order stable
    .slice(0, k)
    .map(({ cand, s }) => ({ ...cand, s }));
}
