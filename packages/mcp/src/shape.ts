// packages/mcp/src/shape.ts — pure response shaping: raw apps/api JSON -> the MCP tool result.
// Zero I/O, zero LLM (CLAUDE.md hard rule 6) — this is what packages/mcp/src/shape.spec.ts
// exercises directly, with fixture JSON, no live server required.

import type { AskApiResponse, ApiBeliefValue, ApiCitation, BeliefApiResponse, CorrectionApiError, CorrectionApiResponse, DiffApiResponse } from './types.js';

// ---- memory_ask ---------------------------------------------------------------------------------

export interface AskAnswered {
  abstained: false;
  answer: string;
  confidence: number;
  claim_confidence?: number;
  corroboration?: number;
  disputed: boolean;
  subject?: string;
  attribute?: string;
  citations: ApiCitation[];
  superseded: ApiBeliefValue[];
}

export interface AskAbstained {
  abstained: true;
  reason: 'not_in_history';
  confidence: number;
  nearest_miss: NonNullable<AskApiResponse['nearest_miss']>;
}

export type AskResult = AskAnswered | AskAbstained;

/** Calibrated abstention is a first-class answer (AGENTS.md), never an error: this always returns
 *  a normal result. Hard rule 3 (every answer carries a citation) is enforced right here — an
 *  "answered" result with no citations is reshaped into an abstention rather than shipped uncited. */
export function shapeAsk(raw: AskApiResponse): AskResult {
  if (raw.abstained || raw.answer == null || raw.citations.length === 0) {
    return { abstained: true, reason: 'not_in_history', confidence: raw.confidence, nearest_miss: raw.nearest_miss ?? [] };
  }
  return {
    abstained: false,
    answer: raw.answer,
    confidence: raw.confidence,
    claim_confidence: raw.claim_confidence,
    corroboration: raw.corroboration,
    disputed: raw.disputed ?? false,
    subject: raw.subject,
    attribute: raw.attribute,
    citations: raw.citations,
    superseded: raw.superseded ?? [],
  };
}

// ---- memory_remember / memory_correct ------------------------------------------------------------

export interface CorrectionOk {
  appended: true;
  claim_id: number;
  edge_id: number;
  event_time: number;
  supersedes_claim_id: number;
  citation: ApiCitation;
}

export interface CorrectionRejected {
  appended: false;
  reason: 'unknown_subject_attribute' | 'invalid_target' | 'invalid_input';
  message: string;
}

export type CorrectionResult = CorrectionOk | CorrectionRejected;

/** A correction claim's own citation is synthetic (apps/api/src/correction.ts, via
 *  @errata/ingest's buildCorrection): session_id "user-correction", turn_index -1. It is still a
 *  citation, honest about provenance — this claim came from the conversation now, not a
 *  transcript line. */
function correctionCitation(res: CorrectionApiResponse): ApiCitation {
  return { session_id: 'user-correction', turn_index: -1, span: `correction, claim ${res.claim_id}`, claim_id: res.claim_id };
}

export function shapeCorrectionOk(res: CorrectionApiResponse): CorrectionOk {
  return { appended: true, claim_id: res.claim_id, edge_id: res.edge_id, event_time: res.event_time, supersedes_claim_id: res.supersedes_claim_id, citation: correctionCitation(res) };
}

/** apps/api has nothing to attach a correction to until the (subject, attribute) has been
 *  ingested at least once — POST /api/correction 404s with no prior claim, because first-write
 *  extraction belongs to the offline pipeline in packages/ingest, not this HTTP surface. Surfaced
 *  here as a structured, typed rejection instead of a thrown error, so an agent can read why. */
export function shapeCorrectionError(status: number, err: CorrectionApiError): CorrectionRejected {
  const reason = status === 404 ? 'unknown_subject_attribute' : status === 409 ? 'invalid_target' : 'invalid_input';
  return { appended: false, reason, message: err.error };
}

// ---- memory_history -------------------------------------------------------------------------------

export interface HistoryEntry {
  value: string;
  event_time: number;
  citation: ApiCitation;
  /** false for a belief currently held; true for a value it (or a descendant) displaced. */
  struck: boolean;
}

export interface HistoryRevision {
  relation: string;
  rationale: string;
  ingest_time: number;
  newer: HistoryEntry;
  older: HistoryEntry;
}

export interface HistoryFound {
  found: true;
  subject: string;
  attribute: string;
  /** every claim that ever held: current heads unstruck, every displaced value struck. */
  current: HistoryEntry[];
  disputed: boolean;
  contested: boolean;
  chain_len: number;
  /** the SUPERSEDES/CONTRADICTS chain, newest-first, each hop naming what displaced what and why. */
  revisions: HistoryRevision[];
  truncated: boolean;
}

export interface HistoryNotFound {
  found: false;
  reason: 'not_in_history';
}

export type HistoryResult = HistoryFound | HistoryNotFound;

function entry(v: ApiBeliefValue, struck: boolean): HistoryEntry {
  return { value: v.value, event_time: v.event_time, citation: v.citation, struck };
}

/** Nothing is ever mutated or deleted (AGENTS.md: "the edge IS the history") — this is the view
 *  that makes that visible: current values alongside every value they displaced, and the exact
 *  chain of revision edges that connects them. */
export function shapeHistory(subject: string, attribute: string, belief: BeliefApiResponse, diff: DiffApiResponse | null): HistoryResult {
  if (!belief.belief && belief.heads.length === 0 && belief.superseded.length === 0) {
    return { found: false, reason: 'not_in_history' };
  }
  const current = [...belief.heads.map((h) => entry(h, false)), ...belief.superseded.map((h) => entry(h, true))];
  const revisions: HistoryRevision[] = (diff?.revisions ?? []).map((r) => ({
    relation: r.relation,
    rationale: r.rationale,
    ingest_time: r.ingest_time,
    newer: entry(r.newer, false),
    older: entry(r.older, true),
  }));
  return {
    found: true,
    subject,
    attribute,
    current,
    disputed: belief.disputed,
    contested: belief.contested,
    chain_len: belief.chain_len,
    revisions,
    truncated: diff?.truncated ?? false,
  };
}
