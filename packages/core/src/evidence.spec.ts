import { describe, it, expect } from 'vitest';
import { scoreEvidence, decide, rankClaimsByFit, tokenF1, contentTokens } from './evidence.js';
import type { EvidenceScore, QuestionFeatures, ScoredClaim } from './index.js';

const q = (p: Partial<QuestionFeatures> = {}): QuestionFeatures => ({
  contentTokens: p.contentTokens ?? ['alpha', 'beta', 'gamma', 'delta'],
  anchorsResolved: p.anchorsResolved ?? 0,
  hasTimeConstraint: p.hasTimeConstraint ?? false,
  timeConstraintViolated: p.timeConstraintViolated ?? false,
});
const cand = (p: Partial<ScoredClaim> = {}): ScoredClaim => ({
  attribute: p.attribute ?? 'employer',
  value: p.value ?? 'globex',
  registryMatched: p.registryMatched ?? true,
  headConfidence: p.headConfidence ?? 0.8,
  judgeConfidence: p.judgeConfidence ?? 1.0,
  corroboration: p.corroboration ?? 3,
});
const TAU = 0.4;

describe('scoreEvidence (spec 31 §7 tests 34-40)', () => {
  it('34: E is monotonically non-decreasing in each of a, s, c, p, d', () => {
    // a — anchor coverage
    expect(scoreEvidence(q({ anchorsResolved: 4 }), [cand()], TAU).E).toBeGreaterThan(
      scoreEvidence(q({ anchorsResolved: 0 }), [cand()], TAU).E,
    );
    // c — claim confidence
    expect(scoreEvidence(q(), [cand({ headConfidence: 0.9 })], TAU).E).toBeGreaterThan(
      scoreEvidence(q(), [cand({ headConfidence: 0.2 })], TAU).E,
    );
    // p — corroboration
    expect(scoreEvidence(q(), [cand({ corroboration: 3 })], TAU).E).toBeGreaterThan(
      scoreEvidence(q(), [cand({ corroboration: 0 })], TAU).E,
    );
    // d — temporal fit (none=0.5 vs satisfied=1.0 vs violated=0)
    const dViolated = scoreEvidence(q({ hasTimeConstraint: true, timeConstraintViolated: true }), [cand()], TAU).E;
    const dNone = scoreEvidence(q({ hasTimeConstraint: false }), [cand()], TAU).E;
    const dOk = scoreEvidence(q({ hasTimeConstraint: true, timeConstraintViolated: false }), [cand()], TAU).E;
    expect(dNone).toBeGreaterThan(dViolated);
    expect(dOk).toBeGreaterThan(dNone);
    // s — best claim fit
    const qTok = q({ contentTokens: ['employer', 'globex'] });
    expect(scoreEvidence(qTok, [cand({ value: 'globex' })], TAU).s).toBeGreaterThan(
      scoreEvidence(qTok, [cand({ value: 'unrelated_thing' })], TAU).s,
    );
  });

  it('35: E stays within [0,1] over random inputs', () => {
    for (let i = 0; i < 5000; i++) {
      const s = scoreEvidence(
        q({ anchorsResolved: Math.floor(Math.random() * 6), contentTokens: ['a', 'b', 'c', 'd'] }),
        [cand({ headConfidence: Math.random(), judgeConfidence: Math.random(), corroboration: Math.floor(Math.random() * 5) })],
        TAU,
      );
      expect(s.E).toBeGreaterThanOrEqual(0);
      expect(s.E).toBeLessThanOrEqual(1);
    }
  });

  it('36: decision boundary — E = τ answers, E = τ − ε abstains', () => {
    const at: EvidenceScore = { a: 0, s: 0, c: 0, p: 0, d: 0, E: 0.4, tau: 0.4 };
    expect(decide(at, 0.4)).toBe('ANSWER');
    expect(decide(at, 0.4, true)).toBe('DISPUTED');
    expect(decide({ ...at, E: 0.399 }, 0.4)).toBe('ABSTAIN');
  });

  it('37: no anchor resolves and nothing retrieved → a=0, s=0 → abstains at any published τ', () => {
    const s = scoreEvidence(q({ contentTokens: ['foo', 'bar'], anchorsResolved: 0 }), [], 0.5);
    expect(s.a).toBe(0);
    expect(s.s).toBe(0);
    for (const tau of [0.1, 0.3, 0.5, 0.9]) expect(decide(s, tau)).toBe('ABSTAIN');
  });

  it('38: anchor resolves but the attribute is absent → abstains', () => {
    const features = q({ contentTokens: ['employer', 'company'], anchorsResolved: 1 });
    const cands = [cand({ attribute: 'car_model', value: 'toyota' })];
    const s = scoreEvidence(features, cands, 0.5);
    expect(s.s).toBe(0);
    expect(decide(s, 0.5)).toBe('ABSTAIN');
  });

  it('39: nearest-miss ranking is stable, ≤3, each with an s value', () => {
    const cands = [
      { attribute: 'employer', value: 'globex', registryMatched: true },
      { attribute: 'employer', value: 'acme corp', registryMatched: true },
      { attribute: 'hobby', value: 'chess', registryMatched: false },
      { attribute: 'city_of_residence', value: 'paris', registryMatched: true },
    ];
    const top = rankClaimsByFit(['employer', 'globex'], cands, 3);
    expect(top).toHaveLength(3);
    expect(top[0]!.value).toBe('globex');
    expect(top.every((t) => typeof t.s === 'number')).toBe(true);
  });

  it('40: a temporal violation (d=0) flips a marginal answer to abstention', () => {
    const cands = [cand({ value: 'globex acme', headConfidence: 0.6, corroboration: 2 })];
    const features = q({ contentTokens: ['employer', 'globex'], anchorsResolved: 1 });
    const noTC = scoreEvidence({ ...features, hasTimeConstraint: false }, cands, TAU);
    const violated = scoreEvidence({ ...features, hasTimeConstraint: true, timeConstraintViolated: true }, cands, TAU);
    expect(noTC.E).toBeGreaterThan(violated.E);
    const tau = (noTC.E + violated.E) / 2;
    expect(decide(noTC, tau)).toBe('ANSWER');
    expect(decide(violated, tau)).toBe('ABSTAIN');
  });

  it('token helpers behave', () => {
    expect(tokenF1(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(tokenF1(['a'], ['b'])).toBe(0);
    expect(contentTokens('What is my Employer?')).toEqual(['employer']);
  });
});
