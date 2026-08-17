import { describe, it, expect } from 'vitest';
import {
  budgetState,
  budgetGuard,
  BudgetExhausted,
  WARN_RATIO,
  THROTTLE_RATIO,
} from './budget.js';

const CAP = 100;

describe('budgetState (the ledger design backpressure ladder)', () => {
  it('normal below 0.70·cap', () => {
    expect(budgetState(0, CAP)).toBe('normal');
    expect(budgetState(69.99, CAP)).toBe('normal');
  });

  it('WARN at exactly 0.70·cap through just under 0.90', () => {
    expect(budgetState(70, CAP)).toBe('WARN');
    expect(budgetState(WARN_RATIO * CAP, CAP)).toBe('WARN');
    expect(budgetState(89.99, CAP)).toBe('WARN');
  });

  it('THROTTLED at exactly 0.90·cap through just under cap', () => {
    expect(budgetState(90, CAP)).toBe('THROTTLED');
    expect(budgetState(THROTTLE_RATIO * CAP, CAP)).toBe('THROTTLED');
    expect(budgetState(99.99, CAP)).toBe('THROTTLED');
  });

  it('EXHAUSTED at exactly cap and above', () => {
    expect(budgetState(100, CAP)).toBe('EXHAUSTED');
    expect(budgetState(250, CAP)).toBe('EXHAUSTED');
  });

  it('a non-positive cap is always EXHAUSTED', () => {
    expect(budgetState(0, 0)).toBe('EXHAUSTED');
    expect(budgetState(0, -5)).toBe('EXHAUSTED');
  });

  it('walks the full ladder normal → WARN → THROTTLED → EXHAUSTED', () => {
    const seq = [0, 70, 90, 100].map((s) => budgetState(s, CAP));
    expect(seq).toEqual(['normal', 'WARN', 'THROTTLED', 'EXHAUSTED']);
  });
});

describe('budgetGuard', () => {
  it('allows every role while normal and WARN', () => {
    expect(budgetGuard(0, CAP, 'extractor')).toEqual({ state: 'normal', allow: true });
    expect(budgetGuard(75, CAP, 'extractor')).toEqual({ state: 'WARN', allow: true });
    expect(budgetGuard(75, CAP, 'judge')).toEqual({ state: 'WARN', allow: true });
  });

  it('while THROTTLED permits judge but pauses extraction', () => {
    expect(budgetGuard(95, CAP, 'judge')).toEqual({ state: 'THROTTLED', allow: true });
    expect(budgetGuard(95, CAP, 'extractor')).toEqual({ state: 'THROTTLED', allow: false });
  });

  it('throws BudgetExhausted at/over the cap for any role', () => {
    expect(() => budgetGuard(100, CAP, 'judge')).toThrow(BudgetExhausted);
    expect(() => budgetGuard(120, CAP, 'extractor')).toThrow(BudgetExhausted);
  });

  it('BudgetExhausted carries spent and cap', () => {
    try {
      budgetGuard(130, CAP, 'judge');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExhausted);
      const e = err as BudgetExhausted;
      expect(e.spent).toBe(130);
      expect(e.cap).toBe(CAP);
    }
  });
});
