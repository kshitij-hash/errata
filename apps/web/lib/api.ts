// The browser's only network surface. Every call is same-origin against the route-handler proxy
// (36 §3.5 / craft rule 5) — the CSP's connect-src 'self' is therefore enforceable.

export interface Citation {
  session_id: string;
  turn_index: number;
  span: string;
  claim_id?: number;
}

export interface CypherStmt {
  text: string;
  params: Record<string, unknown>;
}

export interface BeliefValue {
  value: string;
  attribute: string;
  event_time: number;
  ingest_time: number;
  confidence: number;
  provenance: string;
  judge_status: string;
  corroboration: number;
  citation: Citation;
  evidence_span: string;
}

export interface NearestMiss {
  attribute: string;
  value: string;
  s: number;
  citation: { session_id: string; turn_index: number };
  span: string;
}

export interface AskResponse {
  answer: string | null;
  abstained: boolean;
  disputed?: boolean;
  confidence: number;
  citations: Citation[];
  /** additive v1.1 fields (optional): the resolved belief's coordinates + its struck predecessors */
  subject?: string | null;
  attribute?: string | null;
  superseded?: BeliefValue[];
  corroboration?: number;
  cost: number;
  usage: { prompt_tokens: number; completion_tokens: number };
  cypher: CypherStmt[];
  vector_baseline: {
    answer: string;
    cosine: number;
    citation: unknown;
    embedder: string;
  } | null;
  trace_id: string;
  /** the evidence score that decided answer-vs-abstain: E against the threshold τ */
  evidence: {
    a: number;
    s: number;
    c: number;
    p: number;
    d: number;
    E: number;
    tau: number;
  } | null;
  nearest_miss?: NearestMiss[];
  latency_ms: number;
}

/** One transcript turn from `/api/turns` — the neighbours around a cited span (blocker B2). */
export interface TurnRow {
  turn_id: string;
  session_id: string;
  turn_index: number;
  role: string;
  text: string;
  event_time: number;
  event_time_iso: string;
  /** true for the turn the citation itself points at */
  anchor: boolean;
}

export interface TurnsResponse {
  history_id: string;
  session_id: string;
  session_ordinal: number;
  around_turn: number;
  radius: number;
  turns: TurnRow[];
}

export interface BeliefResponse {
  belief: BeliefValue | null;
  heads: BeliefValue[];
  superseded: BeliefValue[];
  negations: BeliefValue[];
  disputed: boolean;
  contested: boolean;
  chain_len: number;
  cycle_broken: boolean;
  chain_repaired: boolean;
}

export interface DiffRevision {
  newer: BeliefValue;
  older: BeliefValue;
  relation: string;
  ingest_time: number;
  confidence: number;
  provenance: string;
  judge_status: string;
  rationale: string | null;
  citations: { newer: Citation; older: Citation };
}

export interface DiffResponse {
  from_belief: BeliefValue | null;
  to_belief: BeliefValue | null;
  revisions: DiffRevision[];
  validated: { sp_paths: number; enumerated: number; agree: boolean };
  truncated: boolean;
}

export interface MetaResponse {
  answer_model: string;
  answer_mechanism: string;
  answer_prompt_sha256: string;
  extractor_model: string;
  conflict_judge_model: string;
  git_sha: string;
  corpus_revision: string;
  ingested_history_ids: string[];
  schema_version: string | number;
  tau: number;
}

export interface CostsResponse {
  cap_usd: number;
  spent_usd: number;
  budget_state: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
}

const BASE = '/api/errata';

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { accept: 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
  }
  return (await res.json()) as T;
}

export const api = {
  meta: () => json<MetaResponse>('/meta'),
  costs: () => json<CostsResponse>('/meta/costs'),
  ask: (question: string, historyId: string) =>
    json<AskResponse>('/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, history_id: historyId }),
    }),
  belief: (subject: string, attribute: string, historyId: string, at?: number) =>
    json<BeliefResponse>(
      `/belief?subject=${encodeURIComponent(subject)}&attribute=${encodeURIComponent(attribute)}&history_id=${encodeURIComponent(historyId)}${at != null ? `&at=${at}` : ''}`,
    ),
  /** The transcript around a citation. `claimId` is the id-anchored path; session/turn is the
   *  fallback when a citation carries no claim_id. */
  turns: (historyId: string, q: { claimId?: number; sessionId?: string; aroundTurn?: number; radius?: number }) => {
    const p = new URLSearchParams({ history_id: historyId });
    if (q.claimId != null) p.set('claim_id', String(q.claimId));
    if (q.sessionId) p.set('session_id', q.sessionId);
    if (q.aroundTurn != null) p.set('around_turn', String(q.aroundTurn));
    if (q.radius != null) p.set('radius', String(q.radius));
    return json<TurnsResponse>(`/turns?${p.toString()}`);
  },
  diff: (subject: string, attribute: string, historyId: string, from: number, to: number) =>
    json<DiffResponse>(
      `/diff?subject=${encodeURIComponent(subject)}&attribute=${encodeURIComponent(attribute)}&history_id=${encodeURIComponent(historyId)}&from=${from}&to=${to}`,
    ),
  /**
   * The live-correction beat. Appends a claim + SUPERSEDES edge through the API's write path.
   * NOTE: apps/api exposes no write route yet — see var/frontend-blockers.md (B1). Until it does,
   * this resolves to an error and the slip files itself in its "not appended" state.
   */
  correct: (body: {
    history_id: string;
    subject: string;
    attribute: string;
    value: string;
    supersedes_claim_id?: number;
  }) =>
    json<{ claim_id: number; edge_id?: number; event_time?: number }>('/correction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
};

export const usd = (n: number, digits = 4): string => `$${n.toFixed(digits)}`;
