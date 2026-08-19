// packages/mcp/src/shape.spec.ts — pure response shaping. No network, no LLM (CONVENTIONS.md hard rule
// 6): fixtures below are trimmed from a real POST /api/ask / GET /api/belief / GET /api/diff
// response captured against the demo history (docs/mcp-demo.md).

import { describe, expect, it } from 'vitest';
import { shapeAsk, shapeCorrectionError, shapeCorrectionOk, shapeHistory } from './shape.js';
import type { AskApiResponse, BeliefApiResponse, CorrectionApiResponse, DiffApiResponse } from './types.js';

const CITE = (session_id: string, turn_index: number, span: string, claim_id: number) => ({ session_id, turn_index, span, claim_id });

describe('shapeAsk', () => {
  it('shapes an answered result with citations, dropping abstention-only fields', () => {
    const raw: AskApiResponse = {
      answer: '$400,000',
      abstained: false,
      disputed: false,
      confidence: 0.56,
      citations: [CITE('answer_3a6f1e82_2', 0, 'pre-approved for $400,000 from Wells Fargo?', 6423372368317097)],
      subject: 'the user',
      attribute: 'mortgage_preapproval_amount',
      superseded: [],
      claim_confidence: 0.72,
      corroboration: 1,
    };
    const out = shapeAsk(raw);
    expect(out.abstained).toBe(false);
    if (out.abstained) throw new Error('unreachable');
    expect(out.answer).toBe('$400,000');
    expect(out.citations).toHaveLength(1);
    expect(out.citations[0]!.session_id).toBe('answer_3a6f1e82_2');
    expect(out.claim_confidence).toBe(0.72);
  });

  it('abstention is a structured result, not an error, and always carries nearest_miss', () => {
    const raw: AskApiResponse = { answer: null, abstained: true, confidence: 0.12, citations: [], nearest_miss: [{ attribute: 'favorite_color', value: 'unknown', s: 0.1, citation: { session_id: 's1', turn_index: 3 }, span: 'no mention of a favorite color' }] };
    const out = shapeAsk(raw);
    expect(out.abstained).toBe(true);
    if (!out.abstained) throw new Error('unreachable');
    expect(out.reason).toBe('not_in_history');
    expect(out.nearest_miss).toHaveLength(1);
  });

  it('never returns nearest_miss as undefined even when the API omits it', () => {
    const raw: AskApiResponse = { answer: null, abstained: true, confidence: 0, citations: [] };
    const out = shapeAsk(raw);
    expect(out.abstained).toBe(true);
    if (!out.abstained) throw new Error('unreachable');
    expect(out.nearest_miss).toEqual([]);
  });

  it('hard rule 3: an "answered" API response with no citations is reshaped into an abstention rather than shipped uncited', () => {
    const raw: AskApiResponse = { answer: 'some value', abstained: false, confidence: 0.9, citations: [] };
    const out = shapeAsk(raw);
    expect(out.abstained).toBe(true);
  });

  it('passes the executed Cypher through, so a mounted agent can see the SUPERSEDES traversal', () => {
    const cypher = [{ text: 'MATCH (newer:Claim)-[r:SUPERSEDES]->(older:Claim) RETURN newer.id', params: { entity_vid: 1 } }];
    const answered = shapeAsk({ answer: '$425,000', abstained: false, confidence: 0.56, citations: [CITE('user-correction', -1, 'corrected by the user to $425,000', 1675875085541886)], cypher });
    expect(answered.cypher).toEqual(cypher);
    const abstained = shapeAsk({ answer: null, abstained: true, confidence: 0.29, citations: [], cypher });
    expect(abstained.cypher).toEqual(cypher);
  });

  it('omits cypher entirely when the API sent none — the result shape is unchanged for callers that never had it', () => {
    const out = shapeAsk({ answer: null, abstained: true, confidence: 0, citations: [] });
    expect('cypher' in out).toBe(false);
  });
});

describe('correction shaping', () => {
  const OK: CorrectionApiResponse = { claim_id: 42, edge_id: 43, event_time: 1_786_900_000, supersedes_claim_id: 7, appended: true };

  it('shapes a successful correction with a synthetic but present citation', () => {
    const out = shapeCorrectionOk(OK);
    expect(out.appended).toBe(true);
    expect(out.claim_id).toBe(42);
    expect(out.supersedes_claim_id).toBe(7);
    expect(out.citation.session_id).toBe('user-correction');
    expect(out.citation.turn_index).toBe(-1);
    expect(out.citation.claim_id).toBe(42);
  });

  it('maps a 404 (no prior claim to correct) to a typed, non-throwing rejection', () => {
    const out = shapeCorrectionError(404, { error: "unknown subject/attribute for this history: no claim about 'x' with attribute 'y' in h1" });
    expect(out.appended).toBe(false);
    expect(out.reason).toBe('unknown_subject_attribute');
    expect(out.message).toContain('unknown subject/attribute');
  });

  it('maps a 409 (bad supersedes target) distinctly from a 404', () => {
    const out = shapeCorrectionError(409, { error: 'supersedes_claim_id 9 is not a claim about x.y in this history' });
    expect(out.reason).toBe('invalid_target');
  });

  it('maps a 400 to invalid_input', () => {
    const out = shapeCorrectionError(400, { error: 'invalid correction body', issues: [{ path: 'value', message: 'too short' }] });
    expect(out.reason).toBe('invalid_input');
  });
});

describe('shapeHistory', () => {
  const HEAD = { value: '$400,000', attribute: 'mortgage_preapproval_amount', event_time: 1_701_304_560, ingest_time: 1_786_900_426, confidence: 0.72, provenance: 'EXTRACTED', judge_status: 'NONE', corroboration: 1, citation: CITE('answer_3a6f1e82_2', 0, 'pre-approved for $400,000 from Wells Fargo?', 6423372368317097), evidence_span: 'pre-approved for $400,000 from Wells Fargo?' };
  const OLDER = { value: '$350,000', attribute: 'mortgage_preapproval_amount', event_time: 1_691_712_060, ingest_time: 1_786_900_426, confidence: 0.72, provenance: 'EXTRACTED', judge_status: 'NONE', corroboration: 1, citation: CITE('answer_3a6f1e82_1', 2, 'pre-approved for $350,000 from Wells Fargo.', 6341458025447090), evidence_span: 'pre-approved for $350,000 from Wells Fargo.' };

  const belief: BeliefApiResponse = { belief: HEAD, heads: [HEAD], superseded: [OLDER], negations: [], disputed: false, contested: false, chain_len: 2, cycle_broken: false, chain_repaired: false };
  const diff: DiffApiResponse = {
    from_belief: null,
    to_belief: HEAD,
    revisions: [{ newer: HEAD, older: OLDER, relation: 'SUPERSEDES', ingest_time: 1_786_900_426, confidence: 0.7, provenance: 'INFERRED', judge_status: 'NONE', rationale: 'later statement supersedes earlier', citations: { newer: CITE('answer_3a6f1e82_2', 0, '', 6423372368317097), older: CITE('answer_3a6f1e82_1', 2, '', 6341458025447090) } }],
    truncated: false,
  };

  it('marks the current head unstruck and the superseded value struck', () => {
    const out = shapeHistory('the user', 'mortgage_preapproval_amount', belief, diff);
    expect(out.found).toBe(true);
    if (!out.found) throw new Error('unreachable');
    const current = out.current.find((c) => c.value === '$400,000')!;
    const old = out.current.find((c) => c.value === '$350,000')!;
    expect(current.struck).toBe(false);
    expect(old.struck).toBe(true);
  });

  it('surfaces the SUPERSEDES revision with its rationale — nothing mutated, the edge IS the history', () => {
    const out = shapeHistory('the user', 'mortgage_preapproval_amount', belief, diff);
    if (!out.found) throw new Error('unreachable');
    expect(out.revisions).toHaveLength(1);
    expect(out.revisions[0]!.relation).toBe('SUPERSEDES');
    expect(out.revisions[0]!.newer.value).toBe('$400,000');
    expect(out.revisions[0]!.older.value).toBe('$350,000');
    expect(out.revisions[0]!.older.struck).toBe(true);
  });

  it('reports not_in_history, structured, when the (subject, attribute) has no claims at all', () => {
    const empty: BeliefApiResponse = { belief: null, heads: [], superseded: [], negations: [], disputed: false, contested: false, chain_len: 0, cycle_broken: false, chain_repaired: false };
    const out = shapeHistory('the user', 'favorite_color', empty, null);
    expect(out.found).toBe(false);
    if (out.found) throw new Error('unreachable');
    expect(out.reason).toBe('not_in_history');
  });

  it('tolerates a missing diff (belief alone still shows current vs struck)', () => {
    const out = shapeHistory('the user', 'mortgage_preapproval_amount', belief, null);
    expect(out.found).toBe(true);
    if (!out.found) throw new Error('unreachable');
    expect(out.revisions).toEqual([]);
    expect(out.current).toHaveLength(2);
  });
});
