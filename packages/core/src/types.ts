// packages/core/src/types.ts — the schema types shared across Errata. Pure data; no I/O.
//
// Every property is always present (the graph is null-free; unknowns use typed sentinels:
// -1 int, "" string, -1.0 float). Null-free by design: every declared property gets a sentinel.

export const PROVENANCE = ['EXTRACTED', 'INFERRED'] as const;
export type Provenance = (typeof PROVENANCE)[number];

export const JUDGE_STATUS = ['NONE', 'OK', 'LOW_CONF', 'UNPARSED', 'UNJUDGED', 'UNJUDGED'] as const;
export type JudgeStatus = 'NONE' | 'OK' | 'LOW_CONF' | 'UNPARSED' | 'UNJUDGED';

export const POLARITY = ['AFFIRM', 'NEGATE'] as const;
export type Polarity = (typeof POLARITY)[number];

export const ARITY = ['FUNCTIONAL', 'MULTI'] as const;
export type Arity = (typeof ARITY)[number];

export const RELATION = ['SUPERSEDES', 'CONTRADICTS', 'SUPPORTS'] as const;
export type Relation = (typeof RELATION)[number];

export const TIME_BASIS = ['EXPLICIT', 'SESSION_DATE', 'RELATIVE', 'UNKNOWN'] as const;
export type TimeBasis = (typeof TIME_BASIS)[number];

/** Sentinel for an unknown epoch-seconds value (there is no null in the store). */
export const TIME_UNKNOWN = -1;

/** (session_id, positional turn_index) into the transcript. Every answer carries one.
 *  turn_index is the 0-based positional index — never derived by string-splitting turn_id (integration seam). */
export interface Citation {
  session_id: string;
  turn_index: number;
  claim_id?: number;
}

/** A claim row as returned by the belief queries and consumed by the revision fold. */
export interface ClaimRow {
  claim_id: number;
  value: string; // value_text
  value_norm: string;
  attribute: string;
  arity: Arity;
  polarity: Polarity;
  event_time: number; // epoch seconds, -1 unknown
  ingest_time: number; // epoch seconds, never -1
  confidence: number; // 0..1, -1 n/a
  provenance: Provenance;
  judge_status: JudgeStatus;
  session_id: string;
  turn_id: string; // "sessionId:turnIndex" denormalized citation string (graph-internal)
  turn_index: number; // 0-based positional index — the citation half eval asserts against
  evidence_span: string;
  claim_key?: string; // for collision detection (n.key assertion)
}

/** A revision edge among claims (SUPERSEDES / CONTRADICTS / SUPPORTS). */
export interface RevisionEdgeRow {
  newer_id: number;
  older_id: number;
  relation: Relation;
  ingest_time: number;
  confidence: number;
  provenance: Provenance;
  judge_status: JudgeStatus;
  rationale: string;
}

/** A resolved belief value (the head of a chain, or one member of a MULTI set). */
export interface BeliefValue {
  claim_id: number;
  value: string;
  value_norm: string;
  attribute: string;
  event_time: number;
  ingest_time: number;
  confidence: number;
  provenance: Provenance;
  judge_status: JudgeStatus;
  citation: Citation;
  evidence_span: string;
  corroboration: number; // distinct turns citing this belief (origin + SUPPORTS)
}

/** The outcome of folding claims+edges for one (subject, attribute). */
export interface BeliefResult {
  /** The current belief. For FUNCTIONAL: the single head, or null if none / disputed.
   *  For MULTI: null (use `heads`). */
  head: BeliefValue | null;
  /** All current heads. FUNCTIONAL non-disputed → length 1; MULTI → coexisting members;
   *  disputed → the mutually-contradicting set. */
  heads: BeliefValue[];
  /** Displaced claims, still retrievable (the supersession edge is the history). */
  superseded: BeliefValue[];
  /** NEGATE-polarity claims ("no longer X") — surfaced as evidence, not dropped (review a hardening item). */
  negations: BeliefValue[];
  disputed: boolean;
  /** the head is touched by an unresolved CONTRADICTS edge (caps answer confidence downstream). */
  contested: boolean;
  chain_len: number;
  cycle_broken: boolean;
  chain_repaired: boolean;
}

/** One step of a revision chain, for /api/diff. */
export interface Revision {
  newer: BeliefValue;
  older: BeliefValue;
  relation: Relation;
  ingest_time: number;
  confidence: number;
  provenance: Provenance;
  judge_status: JudgeStatus;
  rationale: string;
  citations: { newer: Citation; older: Citation };
}

export interface DiffResult {
  from_belief: BeliefValue | null;
  to_belief: BeliefValue | null;
  revisions: Revision[]; // newest-first
  truncated: boolean;
}

export type TimeAxis = 'event' | 'ingest';

/** Deterministic evidence score (evidence-scoring design). Each component in [0,1]. */
export interface EvidenceScore {
  a: number; // anchor coverage
  s: number; // best claim fit
  c: number; // claim confidence
  p: number; // corroboration
  d: number; // temporal fit
  E: number; // weighted total
  tau: number;
}

export type AnswerDecision = 'ANSWER' | 'ABSTAIN' | 'DISPUTED';
