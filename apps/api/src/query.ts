// apps/api/src/query.ts — orchestration: builder → driver → core fold → response shape.
// Read-only. Every answer carries a citation (hard rule 3). ?explain returns the exact Cypher run.

import {
  claimsForEntities,
  claimsForEntityAttribute,
  keys,
  revisionEdgesForEntity,
  vid,
} from '@errata/graph';
import type { GraphClient, Stmt } from '@errata/graph';
import {
  contentTokens,
  decide,
  diffChain,
  isRegistered,
  rankClaimsByFit,
  resolveAsOf,
  resolveBelief,
  scoreEvidence,
  tokenF1,
} from '@errata/core';
import type { BeliefResult, ClaimRow, RevisionEdgeRow, TimeAxis } from '@errata/core';
import { config } from './deps.js';

/** local copy of the ingest normalizer (kept in sync by test); avoids an api→ingest build edge. */
export function normText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface ExecStmt {
  text: string;
  params: Record<string, unknown>;
  ms: number;
}

async function run(client: GraphClient, stmt: Stmt, sink?: ExecStmt[]): Promise<Record<string, unknown>[]> {
  const t0 = performance.now();
  const rows = await client.read(stmt);
  if (sink) sink.push({ text: stmt.text, params: stmt.params, ms: +(performance.now() - t0).toFixed(2) });
  return rows;
}

const FIRST_PERSON = new Set(['i', 'me', 'my', 'myself', 'mine', 'we', 'our', 'user']);

function toClaimRows(rows: Record<string, unknown>[]): ClaimRow[] {
  return rows as unknown as ClaimRow[];
}

/** Fetch a (subject, attribute)'s claims + all three revision-edge types. */
async function loadBelief(
  client: GraphClient,
  entityVid: number,
  historyId: string,
  attribute: string,
  sink?: ExecStmt[],
): Promise<{ claims: ClaimRow[]; edges: RevisionEdgeRow[] }> {
  const [claims, sup, con, spt] = await Promise.all([
    run(client, claimsForEntityAttribute(entityVid, historyId, attribute), sink),
    run(client, revisionEdgesForEntity(entityVid, historyId, attribute, 'SUPERSEDES'), sink),
    run(client, revisionEdgesForEntity(entityVid, historyId, attribute, 'CONTRADICTS'), sink),
    run(client, revisionEdgesForEntity(entityVid, historyId, attribute, 'SUPPORTS'), sink),
  ]);
  const tag = (rows: Record<string, unknown>[], relation: RevisionEdgeRow['relation']): RevisionEdgeRow[] =>
    rows.map((r) => ({ ...(r as unknown as RevisionEdgeRow), relation }));
  return {
    claims: toClaimRows(claims),
    edges: [...tag(sup, 'SUPERSEDES'), ...tag(con, 'CONTRADICTS'), ...tag(spt, 'SUPPORTS')],
  };
}

function shapeValue(b: BeliefResult['head']): unknown {
  if (!b) return null;
  return {
    value: b.value,
    attribute: b.attribute,
    event_time: b.event_time,
    ingest_time: b.ingest_time,
    confidence: b.confidence,
    provenance: b.provenance,
    judge_status: b.judge_status,
    corroboration: b.corroboration,
    citation: { session_id: b.citation.session_id, turn_id: b.citation.turn_id, claim_id: b.claim_id },
    evidence_span: b.evidence_span,
  };
}

function shapeBelief(result: BeliefResult, statements?: ExecStmt[]): Record<string, unknown> {
  const head = result.head ?? result.heads[0] ?? null;
  return {
    belief: shapeValue(head),
    heads: result.heads.map(shapeValue),
    superseded: result.superseded.map(shapeValue),
    disputed: result.disputed,
    contested: result.contested,
    chain_len: result.chain_len,
    cycle_broken: result.cycle_broken,
    chain_repaired: result.chain_repaired,
    ...(statements ? { explain: { statements } } : {}),
  };
}

export interface BeliefQuery {
  subject: string;
  attribute: string;
  at?: number;
  axis?: TimeAxis;
  historyId: string;
  explain?: boolean;
}

export async function beliefQuery(client: GraphClient, q: BeliefQuery): Promise<Record<string, unknown>> {
  const entityVid = vid(keys.entity(q.historyId, normText(q.subject)));
  const sink: ExecStmt[] | undefined = q.explain ? [] : undefined;
  const { claims, edges } = await loadBelief(client, entityVid, q.historyId, normText2attr(q.attribute), sink);
  const result = q.at != null ? resolveAsOf(claims, edges, q.at, q.axis ?? 'event') : resolveBelief(claims, edges);
  return shapeBelief(result, sink);
}

/** attributes are stored canonically; normalize a query attribute the same way the extractor did. */
function normText2attr(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export interface DiffQuery {
  subject: string;
  attribute: string;
  from: number;
  to: number;
  historyId: string;
  explain?: boolean;
}

export async function diffQuery(client: GraphClient, q: DiffQuery): Promise<Record<string, unknown>> {
  const entityVid = vid(keys.entity(q.historyId, normText(q.subject)));
  const sink: ExecStmt[] | undefined = q.explain ? [] : undefined;
  const { claims, edges } = await loadBelief(client, entityVid, q.historyId, normText2attr(q.attribute), sink);
  const diff = diffChain(claims, edges, q.from, q.to);
  return {
    from_belief: shapeValue(diff.from_belief),
    to_belief: shapeValue(diff.to_belief),
    revisions: diff.revisions.map((r) => ({
      newer: shapeValue(r.newer),
      older: shapeValue(r.older),
      relation: r.relation,
      ingest_time: r.ingest_time,
      confidence: r.confidence,
      provenance: r.provenance,
      judge_status: r.judge_status,
      rationale: r.rationale,
      citations: r.citations,
    })),
    truncated: diff.truncated,
    ...(sink ? { explain: { statements: sink } } : {}),
  };
}

function hasTimeConstraint(question: string): boolean {
  return /\b(20\d{2}|january|february|march|april|may|june|july|august|september|october|november|december|yesterday|last (week|month|year)|when|before|after|on \w+ \d)\b/i.test(question);
}

export interface AskResult {
  kind: 'answer' | 'abstention' | 'disputed';
  text: string;
  confidence: number;
  citations: unknown[];
  evidence: unknown;
  nearest_miss?: unknown[];
  latency_ms: number;
  statements?: ExecStmt[];
}

export async function askQuery(client: GraphClient, historyId: string, question: string, lex: { self: number[]; terms: Record<string, number[]> } | null, explain = false): Promise<AskResult> {
  const t0 = performance.now();
  const sink: ExecStmt[] | undefined = explain ? [] : undefined;
  const tokens = contentTokens(question);
  const qLower = question.toLowerCase();
  const firstPerson = /\b(i|me|my|myself|mine|we|our)\b/i.test(qLower);

  // resolve anchors (spec 31 §4.7 step 0): lexicon terms + first-person → SELF
  const anchorSet = new Set<number>();
  let resolved = 0;
  if (firstPerson && lex) for (const id of lex.self) anchorSet.add(id);
  for (const t of tokens) {
    const ids = lex?.terms[t];
    if (ids && ids.length) {
      for (const id of ids) anchorSet.add(id);
      resolved++;
    } else if (FIRST_PERSON.has(t)) {
      resolved++;
    }
  }
  const anchors = [...anchorSet].slice(0, 8);
  const anchorsResolved = Math.min(resolved, tokens.length);

  const abstain = (nearest: unknown[]): AskResult => {
    const score = scoreEvidence({ contentTokens: tokens, anchorsResolved, hasTimeConstraint: hasTimeConstraint(question), timeConstraintViolated: false }, [], config.tau);
    return { kind: 'abstention', text: "That isn't in this history.", confidence: score.E, citations: [], nearest_miss: nearest, evidence: score, latency_ms: +(performance.now() - t0).toFixed(1), ...(sink ? { statements: sink } : {}) };
  };

  if (anchors.length === 0) return abstain([]);

  // retrieve claims at anchors
  const claimRows = await run(client, claimsForEntities(anchors, historyId), sink);
  const cands = claimRows.map((r) => ({ attribute: String(r.attribute), value: String(r.value), registryMatched: isRegistered(String(r.attribute)), _row: r }));
  const ranked = rankClaimsByFit(tokens, cands, 3);
  const nmOf = (): unknown[] =>
    ranked.map((c) => ({ attribute: c.attribute, value: c.value, s: c.s, citation: { session_id: c._row.session_id, turn_id: c._row.turn_id }, evidence_span: c._row.evidence_span }));

  // Choose the answer attribute by attribute-NAME fit (the question's head noun names the attribute),
  // with value/span only as a light tiebreak — so "the amount ... from Wells Fargo" resolves the
  // pre-approval amount, not the lender the question also mentions (entity disambiguation).
  const attrFit = (r: Record<string, unknown>): number =>
    tokenF1(tokens, contentTokens(String(r.attribute).replace(/_/g, ' '))) +
    0.2 * tokenF1(tokens, contentTokens(`${String(r.value)} ${String(r.evidence_span ?? '')}`));
  let best: Record<string, unknown> | undefined;
  let bestSc = 0;
  for (const r of claimRows) {
    const sc = attrFit(r);
    if (sc > bestSc) {
      bestSc = sc;
      best = r;
    }
  }
  if (!best) return abstain(nmOf());

  // resolve the belief for the chosen attribute at the primary (SELF or first) anchor
  const bestAttr = normText2attr(String(best.attribute));
  const primary = firstPerson && lex?.self.length ? lex.self[0]! : anchors[0]!;
  const { claims, edges } = await loadBelief(client, primary, historyId, bestAttr, sink);
  const belief = resolveBelief(claims, edges);
  const head = belief.head ?? belief.heads[0] ?? null;

  const cand = head ? [{ attribute: bestAttr, value: head.value, registryMatched: isRegistered(bestAttr), headConfidence: head.confidence, judgeConfidence: head.judge_status === 'UNJUDGED' ? 0.5 : 1.0, corroboration: head.corroboration }] : [];
  const score = scoreEvidence({ contentTokens: tokens, anchorsResolved, hasTimeConstraint: hasTimeConstraint(question), timeConstraintViolated: false }, cand, config.tau);
  const decision = decide(score, config.tau, belief.disputed);
  const latency = +(performance.now() - t0).toFixed(1);

  if ((decision === 'ANSWER' || decision === 'DISPUTED') && head) {
    const conf = belief.contested && !belief.disputed ? +(score.E * 0.7).toFixed(3) : score.E;
    const citations = (belief.disputed ? belief.heads : [head]).map((h) => ({ session_id: h.citation.session_id, turn_id: h.citation.turn_id, claim_id: h.claim_id, quote: h.evidence_span }));
    return {
      kind: belief.disputed ? 'disputed' : 'answer',
      text: belief.disputed ? belief.heads.map((h) => h.value).join(' | ') : head.value,
      confidence: conf,
      citations,
      evidence: score,
      latency_ms: latency,
      ...(sink ? { statements: sink } : {}),
    };
  }

  return { kind: 'abstention', text: "That isn't in this history.", confidence: score.E, citations: [], nearest_miss: nmOf(), evidence: score, latency_ms: latency, ...(sink ? { statements: sink } : {}) };
}
