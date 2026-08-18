// packages/mcp/src/types.ts — the shapes this package reads off apps/api's JSON responses.
//
// apps/api is an app, not a library: it has no package this package can import types from. These
// interfaces are a narrow, hand-kept mirror of the fields the four tools actually read (contract
// v1.1 — apps/api/src/query.ts, correction.ts). Pure data; no I/O.

/** v1.1 citation: {session_id, turn_index, span} (+ claim_id). Every cited value carries one. */
export interface ApiCitation {
  session_id: string;
  turn_index: number;
  span: string;
  claim_id?: number;
}

export interface ApiBeliefValue {
  value: string;
  attribute: string;
  event_time: number;
  ingest_time: number;
  confidence: number;
  provenance: string;
  judge_status: string;
  corroboration: number;
  citation: ApiCitation;
  evidence_span: string;
}

/** POST /api/ask response (contract v1.1; apps/api/src/query.ts AskResult, trimmed to what a tool needs). */
export interface AskApiResponse {
  answer: string | null;
  abstained: boolean;
  disputed?: boolean;
  confidence: number;
  citations: ApiCitation[];
  subject?: string;
  attribute?: string;
  superseded?: ApiBeliefValue[];
  claim_confidence?: number;
  corroboration?: number;
  nearest_miss?: { attribute: string; value: string; s: number; citation: { session_id: string; turn_index: number }; span: string }[];
}

/** GET /api/belief response (apps/api/src/query.ts shapeBelief). */
export interface BeliefApiResponse {
  belief: ApiBeliefValue | null;
  heads: ApiBeliefValue[];
  superseded: ApiBeliefValue[];
  negations: ApiBeliefValue[];
  disputed: boolean;
  contested: boolean;
  chain_len: number;
  cycle_broken: boolean;
  chain_repaired: boolean;
}

/** GET /api/diff response (apps/api/src/query.ts diffQuery). */
export interface DiffApiResponse {
  from_belief: ApiBeliefValue | null;
  to_belief: ApiBeliefValue | null;
  revisions: {
    newer: ApiBeliefValue;
    older: ApiBeliefValue;
    relation: string;
    ingest_time: number;
    confidence: number;
    provenance: string;
    judge_status: string;
    rationale: string;
    citations: { newer: ApiCitation; older: ApiCitation };
  }[];
  truncated: boolean;
}

/** 201 body of POST /api/correction (apps/api/src/correction.ts CorrectionResult). */
export interface CorrectionApiResponse {
  claim_id: number;
  edge_id: number;
  event_time: number;
  supersedes_claim_id: number;
  appended: true;
}

/** 400/404/409 body of POST /api/correction. */
export interface CorrectionApiError {
  error: string;
  issues?: { path: string; message: string }[];
}
