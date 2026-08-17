// packages/llm/src/budget.ts — the budget guard (ledger design).
//
// A hard money ceiling with graded backpressure computed off the running spent total:
//   spent < 0.70·cap  → normal    (spend freely)
//   spent ≥ 0.70·cap  → WARN      (surface it; keep spending)
//   spent ≥ 0.90·cap  → THROTTLED (judge calls only; extraction pauses)
//   spent ≥ cap       → EXHAUSTED (throw BudgetExhausted; nothing runs)
// A 402 from OpenRouter short-circuits straight to EXHAUSTED regardless of the local tally.

export const BUDGET_STATES = ['normal', 'WARN', 'THROTTLED', 'EXHAUSTED'] as const;
export type BudgetState = (typeof BUDGET_STATES)[number];

export const WARN_RATIO = 0.7;
export const THROTTLE_RATIO = 0.9;

/** Role that is still permitted to run while THROTTLED (extraction is paused, judging continues). */
export const THROTTLE_ALLOWED_ROLE = 'judge';

/** Thrown when spend has hit the cap (or a 402 circuit-broke). Aborts the run. */
export class BudgetExhausted extends Error {
  readonly spent: number;
  readonly cap: number;
  constructor(spent: number, cap: number, message?: string) {
    super(message ?? `budget exhausted: spent ${spent} of cap ${cap}`);
    this.name = 'BudgetExhausted';
    this.spent = spent;
    this.cap = cap;
  }
}

/** Thrown when a non-judge (extraction) call is attempted while THROTTLED. */
export class BudgetThrottled extends Error {
  readonly role: string;
  readonly spent: number;
  readonly cap: number;
  constructor(role: string, spent: number, cap: number) {
    super(`budget throttled: role '${role}' paused (spent ${spent} of cap ${cap})`);
    this.name = 'BudgetThrottled';
    this.role = role;
    this.spent = spent;
    this.cap = cap;
  }
}

/** Pure state from the running spent total and the cap. A non-positive cap is always EXHAUSTED. */
export function budgetState(spent: number, cap: number): BudgetState {
  if (cap <= 0) return 'EXHAUSTED';
  const ratio = spent / cap;
  if (ratio >= 1) return 'EXHAUSTED';
  if (ratio >= THROTTLE_RATIO) return 'THROTTLED';
  if (ratio >= WARN_RATIO) return 'WARN';
  return 'normal';
}

export interface GuardResult {
  state: BudgetState;
  /** whether a call for this role may proceed. */
  allow: boolean;
}

/**
 * The guard the client consults before every call. Throws BudgetExhausted at/over the cap;
 * for THROTTLED it allows only judge calls (extraction is paused). Never mutates anything.
 */
export function budgetGuard(spent: number, cap: number, role: string): GuardResult {
  const state = budgetState(spent, cap);
  if (state === 'EXHAUSTED') throw new BudgetExhausted(spent, cap);
  const allow = state !== 'THROTTLED' || role === THROTTLE_ALLOWED_ROLE;
  return { state, allow };
}
