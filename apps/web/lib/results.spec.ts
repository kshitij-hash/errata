import { describe, expect, it } from 'vitest';
import {
  ARITH_DIFF,
  ARMS,
  EXPERIMENTS,
  PUBLISHED,
  QUESTIONS,
  REVERT_DIFF_ROWS,
  SEEDS,
  abstentionPR,
  all450,
  cell,
  citedAnswers,
  ctxTokens,
  cut,
  judgeFAR,
  judgeFRR,
  judgeFamily,
  questionsIn,
  row,
  tauSweep,
  type ArmKey,
} from './results';

/**
 * The /results route recomputes every score from the bundled rows. This spec asserts that the
 * recomputation equals the README NUMBERS BLOCK — the source of truth — so the page cannot drift
 * from what the project publishes, in either direction.
 */

const ARM_KEYS: ArmKey[] = ['errata', 'full_context', 'naive'];

describe('the comparison set', () => {
  it('is the seeded 150 with all 30 abstention questions', () => {
    expect(QUESTIONS).toHaveLength(150);
    expect(QUESTIONS.filter((q) => q.abstention)).toHaveLength(30);
    expect(SEEDS).toEqual([11, 22, 33]);
  });

  it('carries a judged row for every arm and every question', () => {
    for (const arm of ARM_KEYS) {
      for (const q of QUESTIONS) {
        const r = row(arm, q.id);
        expect(r.abstained).toHaveLength(3);
        expect(r.verdicts).toHaveLength(3);
      }
    }
  });

  it('scores the four ability columns over the 120 non-abstention questions', () => {
    const n = ['information_extraction', 'multi_session', 'temporal', 'knowledge_update']
      .map((k) => QUESTIONS.filter((q) => q.ability === k).length)
      .reduce((a, b) => a + b, 0);
    expect(n).toBe(120);
  });
});

describe('the published three-arm table, recomputed from the rows', () => {
  for (const arm of ARM_KEYS) {
    const want = PUBLISHED.table[arm];
    it(`${arm} — overall ${want.overall}`, () => {
      expect(Number(cell(arm, cut('overall')!).pct.toFixed(1))).toBe(want.overall);
    });
    it(`${arm} — the four ability columns`, () => {
      expect(Number(cell(arm, cut('information-extraction')!).pct.toFixed(1))).toBe(want.information_extraction);
      expect(Number(cell(arm, cut('multi-session')!).pct.toFixed(1))).toBe(want.multi_session);
      expect(Number(cell(arm, cut('temporal')!).pct.toFixed(1))).toBe(want.temporal);
      expect(Number(cell(arm, cut('knowledge-update')!).pct.toFixed(1))).toBe(want.knowledge_update);
    });
    it(`${arm} — all-450, context tokens, abstention P/R`, () => {
      expect(Number(all450(arm).toFixed(1))).toBe(PUBLISHED.all450[arm]);
      expect(Math.round(ctxTokens(arm))).toBe(PUBLISHED.ctxTok[arm]);
      const pr = abstentionPR(arm);
      expect(Number(pr.p.toFixed(2))).toBe(PUBLISHED.abstention[arm].p);
      expect(Number(pr.r.toFixed(2))).toBe(PUBLISHED.abstention[arm].r);
    });
  }

  it('the ± spread is zero for the deterministic arms and non-zero for full-context', () => {
    expect(cell('errata', cut('overall')!).sd).toBe(0);
    expect(cell('naive', cut('overall')!).sd).toBe(0);
    expect(Number(cell('full_context', cut('overall')!).sd.toFixed(1))).toBe(0.8);
  });
});

describe('the honest gap, by the corpus’s own question_type (eval/RESULTS.md)', () => {
  const published: Record<string, Record<ArmKey, number>> = {
    'single-session-user': { errata: 100.0, full_context: 100.0, naive: 77.3 },
    'single-session-assistant': { errata: 7.1, full_context: 92.9, naive: 92.9 },
    'single-session-preference': { errata: 0.0, full_context: 20.8, naive: 0.0 },
    'multi-session': { errata: 72.1, full_context: 46.5, naive: 47.3 },
    'temporal-reasoning': { errata: 59.0, full_context: 23.9, naive: 33.3 },
    'knowledge-update': { errata: 95.8, full_context: 62.5, naive: 87.5 },
  };
  for (const [type, want] of Object.entries(published)) {
    it(type, () => {
      for (const arm of ARM_KEYS) {
        expect(Number(cell(arm, cut(`type-${type}`)!).pct.toFixed(1))).toBe(want[arm]);
      }
    });
  }

  it('the two losing types are 22 of the 150 questions', () => {
    const n =
      questionsIn(cut('type-single-session-assistant')!).length +
      questionsIn(cut('type-single-session-preference')!).length;
    expect(n).toBe(22);
  });
});

describe('the rejected experiments (eval/RESULTS.md)', () => {
  it('rerunG-max45 — widening the window scored 60.0, below the 65.3 it replaced', () => {
    expect(EXPERIMENTS['rerunF-wave']!.all450).toBe(65.3);
    expect(EXPERIMENTS['rerunG-max45']!.all450).toBe(60.0);
    expect(EXPERIMENTS['rerunG-max45']!.answered).toBe(285);
    expect(EXPERIMENTS['rerunG-max45']!.answered_prec).toBe(66.3);
    expect(EXPERIMENTS['rerunG-max45']!.ctx_tok).toBe(3670);
  });

  it('rerunH-typed — the $0 recall pass scored 62.7 with answered-precision 68.0', () => {
    expect(EXPERIMENTS['rerunH-typed']!.all450).toBe(62.7);
    expect(EXPERIMENTS['rerunH-typed']!.answered_prec).toBe(68.0);
  });

  it('rerunI-restored — the revert is verified, not asserted: 0 of 450 answers differ', () => {
    expect(REVERT_DIFF_ROWS).toBe(0);
    expect(EXPERIMENTS['rerunI-restored']!.all450).toBe(65.3);
  });

  it('rerunJ-arith — three answers changed and none regressed', () => {
    expect(EXPERIMENTS['rerunJ-arith']!.all450).toBe(66.7);
    expect(ARITH_DIFF).toHaveLength(3);
    expect(ARITH_DIFF.filter((d) => d.verdict_before === 'CORRECT' && d.verdict_after !== 'CORRECT')).toHaveLength(0);
    expect(ARITH_DIFF.filter((d) => d.verdict_before !== 'CORRECT' && d.verdict_after === 'CORRECT')).toHaveLength(2);
  });
});

describe('the τ sweep (eval/out/tau-sweep-arith.md)', () => {
  /** τ · overall · answered · answered-precision · abstention P · abstention R, as published. */
  const published: [number, number, number, number, number, number][] = [
    [0.2, 66.7, 279, 77.4, 0.49, 0.93],
    [0.25, 66.7, 279, 77.4, 0.49, 0.93],
    [0.3, 66.7, 279, 77.4, 0.49, 0.93],
    [0.35, 66.7, 276, 78.3, 0.48, 0.93],
    [0.4, 65.3, 270, 77.8, 0.47, 0.93],
    [0.45, 63.3, 255, 78.8, 0.43, 0.93],
    [0.5, 59.3, 219, 82.2, 0.38, 0.97],
    [0.55, 48.0, 147, 87.8, 0.29, 0.97],
  ];

  it('reproduces the committed sweep line for line', () => {
    const got = tauSweep();
    expect(got).toHaveLength(published.length);
    published.forEach(([tau, overall, answered, prec, p, r], i) => {
      const row = got[i]!;
      expect(row.tau).toBe(tau);
      expect(Number(row.overall.toFixed(1))).toBe(overall);
      expect(row.answered).toBe(answered);
      expect(Number(row.answeredPrec.toFixed(1))).toBe(prec);
      expect(Number(row.p.toFixed(2))).toBe(p);
      expect(Number(row.r.toFixed(2))).toBe(r);
    });
  });

  it('is a plateau, not a knife edge: flat at 66.7 across τ ∈ [0.20, 0.35]', () => {
    const flat = tauSweep().filter((t) => t.tau <= 0.35);
    expect(new Set(flat.map((t) => Number(t.overall.toFixed(1))))).toEqual(new Set([66.7]));
    expect(tauSweep().find((t) => t.shipped)!.tau).toBe(0.35);
  });
});

describe('judge validation (eval/judge-validation.md)', () => {
  it('false-accept 8.3% (5/60) against a ≤10% gate', () => {
    const far = judgeFAR();
    expect(far.n).toBe(60);
    expect(far.accepted).toBe(5);
    expect(Number(far.pct.toFixed(1))).toBe(8.3);
    expect(far.unparseable).toBe(6);
  });

  it('false-reject 0.0% (0/60)', () => {
    const frr = judgeFRR();
    expect(frr.n).toBe(60);
    expect(frr.rejected).toBe(0);
  });

  it('superseded-value is 0/12 — the family this project’s thesis rests on', () => {
    const f = judgeFamily('superseded-value');
    expect(f.accepted).toBe(0);
    expect(f.n).toBe(12);
  });

  it('attribution-flip is 25.0% (3/12) and FAILS its own gate — published as a failure', () => {
    const f = judgeFamily('attribution-flip');
    expect(f.accepted).toBe(3);
    expect(Number(f.far.toFixed(1))).toBe(25.0);
    expect(f.far).toBeGreaterThan(f.gate);
    expect(f.unparseable).toBe(6);
  });
});

describe('hard rule 3 — an uncited answer is a bug', () => {
  it('every answered Errata row in the published run carries a citation', () => {
    const c = citedAnswers('errata');
    expect(c.answered).toBe(279);
    expect(c.cited).toBe(c.answered);
    expect(c.abstained).toBe(450 - 279);
  });
});

describe('provenance', () => {
  it('names the run of record for each arm', () => {
    expect(ARMS.map((a) => a.run)).toEqual(['rerunJ-arith', 'rerunB-nothink', 'rerunC-nothink']);
  });
});
