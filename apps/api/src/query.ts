// apps/api/src/query.ts — orchestration: builder → driver → core fold → response shape.
// Read-only. Every answer carries a citation with a positional turn_index (hard rule 3, seam #2).
// Responses follow contract v1.1 (blueprint §2).

import { randomUUID } from 'node:crypto';
import {
  claimsForEntities,
  claimsForEntityAttribute,
  enumerateChain,
  keys,
  revisionEdgesForEntity,
  spPaths,
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
import type { BeliefResult, BeliefValue, ClaimRow, Citation, RevisionEdgeRow, TimeAxis } from '@errata/core';
import { beatFixture, config } from './deps.js';

/** local copy of the ingest normalizer (asserted in sync by app.spec); avoids an api→ingest edge. */
export function normText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
/** attributes are stored canonically; normalize a query attribute the way the extractor did. */
function normAttr(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

interface Cypher {
  text: string;
  params: Record<string, unknown>;
}
async function run(client: GraphClient, stmt: Stmt, sink?: Cypher[]): Promise<Record<string, unknown>[]> {
  if (sink) sink.push({ text: stmt.text, params: stmt.params });
  return client.read(stmt);
}

const FIRST_PERSON = new Set(['i', 'me', 'my', 'myself', 'mine', 'we', 'our', 'user']);

/** v1.1 citation: {session_id, turn_index, span} (+ claim_id for the UI). turn_index is positional. */
function cite(c: Citation, span: string): { session_id: string; turn_index: number; span: string; claim_id?: number } {
  return { session_id: c.session_id, turn_index: c.turn_index, span, claim_id: c.claim_id };
}

/** Fetch a (subject, attribute)'s claims + all three revision-edge types. */
async function loadBelief(client: GraphClient, entityVid: number, historyId: string, attribute: string, sink?: Cypher[]): Promise<{ claims: ClaimRow[]; edges: RevisionEdgeRow[] }> {
  const [claims, sup, con, spt] = await Promise.all([
    run(client, claimsForEntityAttribute(entityVid, historyId, attribute), sink),
    run(client, revisionEdgesForEntity(entityVid, historyId, attribute, 'SUPERSEDES'), sink),
    run(client, revisionEdgesForEntity(entityVid, historyId, attribute, 'CONTRADICTS'), sink),
    run(client, revisionEdgesForEntity(entityVid, historyId, attribute, 'SUPPORTS'), sink),
  ]);
  const tag = (rows: Record<string, unknown>[], relation: RevisionEdgeRow['relation']): RevisionEdgeRow[] =>
    rows.map((r) => ({ ...(r as unknown as RevisionEdgeRow), relation }));
  return {
    claims: claims as unknown as ClaimRow[],
    edges: [...tag(sup, 'SUPERSEDES'), ...tag(con, 'CONTRADICTS'), ...tag(spt, 'SUPPORTS')],
  };
}

function shapeValue(b: BeliefValue | null): unknown {
  if (!b) return null;
  return {
    value: b.value, attribute: b.attribute, event_time: b.event_time, ingest_time: b.ingest_time,
    confidence: b.confidence, provenance: b.provenance, judge_status: b.judge_status, corroboration: b.corroboration,
    citation: cite(b.citation, b.evidence_span), evidence_span: b.evidence_span,
  };
}

function shapeBelief(result: BeliefResult, cypher?: Cypher[]): Record<string, unknown> {
  const head = result.head ?? result.heads[0] ?? null;
  return {
    belief: shapeValue(head),
    heads: result.heads.map(shapeValue),
    superseded: result.superseded.map(shapeValue),
    negations: result.negations.map(shapeValue),
    disputed: result.disputed, contested: result.contested, chain_len: result.chain_len,
    cycle_broken: result.cycle_broken, chain_repaired: result.chain_repaired,
    ...(cypher ? { cypher } : {}),
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
  const sink: Cypher[] | undefined = q.explain ? [] : undefined;
  const { claims, edges } = await loadBelief(client, entityVid, q.historyId, normAttr(q.attribute), sink);
  const result = q.at != null ? resolveAsOf(claims, edges, q.at, q.axis ?? 'event') : resolveBelief(claims, edges);
  return shapeBelief(result, sink);
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
  const sink: Cypher[] | undefined = q.explain ? [] : undefined;
  const { claims, edges } = await loadBelief(client, entityVid, q.historyId, normAttr(q.attribute), sink);
  const diff = diffChain(claims, edges, q.from, q.to);

  // cross-validate the in-memory chain against the graph (spec 31 §4.6, the pathCount-lie guard):
  // algo.SPpaths + a bounded enumeration must agree with core.diffChain on the older-claim set.
  let validated = { sp_paths: 0, enumerated: 0, agree: true };
  if (diff.to_belief && diff.revisions.length > 0) {
    const toId = diff.to_belief.claim_id;
    const fromId = diff.from_belief?.claim_id;
    const [spRows, enumRows] = await Promise.all([
      fromId != null ? run(client, spPaths(toId, fromId), sink) : Promise.resolve([] as Record<string, unknown>[]),
      run(client, enumerateChain(toId, q.historyId), sink),
    ]);
    const enumerated = new Set(enumRows.map((r) => Number(r.older_id)));
    const coreOlder = diff.revisions.map((r) => r.older.claim_id);
    validated = { sp_paths: spRows.length, enumerated: enumerated.size, agree: coreOlder.every((id) => enumerated.has(id)) };
  }

  return {
    from_belief: shapeValue(diff.from_belief),
    to_belief: shapeValue(diff.to_belief),
    revisions: diff.revisions.map((r) => ({
      newer: shapeValue(r.newer), older: shapeValue(r.older), relation: r.relation,
      ingest_time: r.ingest_time, confidence: r.confidence, provenance: r.provenance, judge_status: r.judge_status,
      rationale: r.rationale, citations: { newer: cite(r.citations.newer, r.newer.evidence_span), older: cite(r.citations.older, r.older.evidence_span) },
    })),
    validated,
    truncated: diff.truncated,
    ...(sink ? { cypher: sink } : {}),
  };
}

function hasTimeConstraint(question: string): boolean {
  return /\b(20\d{2}|january|february|march|april|may|june|july|august|september|october|november|december|yesterday|last (week|month|year)|when|before|after|on \w+ \d)\b/i.test(question);
}

/** Contract v1.1 ask response. `answer`, `abstained`, `citations`, `confidence` are ALWAYS present
 * (the eval's ErrataArm rejects a body missing any of them); `answer` is null when abstaining. */
export interface AskResult {
  answer: string | null;
  abstained: boolean;
  disputed?: boolean;
  confidence: number;
  citations: { session_id: string; turn_index: number; span: string; claim_id?: number }[];
  cost: number;
  usage: { prompt_tokens: number; completion_tokens: number };
  cypher: Cypher[];
  vector_baseline: unknown;
  trace_id: string;
  evidence: unknown;
  nearest_miss?: unknown[];
  latency_ms: number;
}

export async function askQuery(client: GraphClient, historyId: string, question: string, lex: { self: number[]; terms: Record<string, number[]> } | null): Promise<AskResult> {
  const t0 = performance.now();
  const cypher: Cypher[] = []; // always surfaced (criterion 02 shows the Cypher on screen)
  const tokens = contentTokens(question);
  const firstPerson = /\b(i|me|my|myself|mine|we|our)\b/i.test(question.toLowerCase());
  const trace_id = randomUUID();
  // the losing pane of demo beat 1: what a vector store returns for this question (served from the
  // committed bge-small fixture, R4). Only attached when the question matches the fixture's query.
  const beat = beatFixture();
  // a vector store returns the HIGHEST-cosine candidate — which in the beat is the *superseded*
  // claim, the whole point of the demo (similarity ranks the stale fact above the current one).
  const top = beat?.candidates.slice().sort((a, b) => b.cosine - a.cosine)[0];
  const vector_baseline =
    beat && top && tokenF1(tokens, contentTokens(beat.query)) >= 0.5
      ? { answer: top.text, cosine: top.cosine, citation: top.citation ?? null, embedder: beat.embedder }
      : null;
  const base = { cost: 0, usage: { prompt_tokens: 0, completion_tokens: 0 }, cypher, vector_baseline, trace_id };

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
    return { answer: null, abstained: true, confidence: score.E, citations: [], nearest_miss: nearest, evidence: score, latency_ms: +(performance.now() - t0).toFixed(1), ...base };
  };

  if (anchors.length === 0) return abstain([]);

  const claimRows = await run(client, claimsForEntities(anchors, historyId), cypher);
  const nmOf = (): unknown[] => {
    const cands = claimRows.map((r) => ({ attribute: String(r.attribute), value: String(r.value), registryMatched: isRegistered(String(r.attribute)), _row: r }));
    return rankClaimsByFit(tokens, cands, 3).map((c) => ({ attribute: c.attribute, value: c.value, s: c.s, citation: { session_id: String(c._row.session_id), turn_index: Number(c._row.turn_index) }, span: c._row.evidence_span }));
  };

  // Choose the answer attribute by attribute-NAME fit (the question's head noun names the attribute),
  // with value/span only a light tiebreak — so "the amount ... from Wells Fargo" resolves the
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

  // resolve the belief for the chosen attribute at the best claim's own SUBJECT entity (P2-15 —
  // deriving from best.subject, not insertion order, so non-first-person questions don't misfire).
  const bestAttr = normAttr(String(best.attribute));
  const subjectNorm = best.subject_norm ? String(best.subject_norm) : '';
  const primary = subjectNorm
    ? vid(keys.entity(historyId, subjectNorm))
    : firstPerson && lex?.self.length
      ? lex.self[0]!
      : anchors[0]!;
  const { claims, edges } = await loadBelief(client, primary, historyId, bestAttr, cypher);
  const belief = resolveBelief(claims, edges);
  const head = belief.head ?? belief.heads[0] ?? null;

  const cand = head ? [{ attribute: bestAttr, value: head.value, registryMatched: isRegistered(bestAttr), headConfidence: head.confidence, judgeConfidence: head.judge_status === 'UNJUDGED' ? 0.5 : 1.0, corroboration: head.corroboration }] : [];
  const score = scoreEvidence({ contentTokens: tokens, anchorsResolved, hasTimeConstraint: hasTimeConstraint(question), timeConstraintViolated: false }, cand, config.tau);
  const decision = decide(score, config.tau, belief.disputed);
  const latency = +(performance.now() - t0).toFixed(1);

  if ((decision === 'ANSWER' || decision === 'DISPUTED') && head) {
    const conf = belief.contested && !belief.disputed ? +(score.E * 0.7).toFixed(3) : score.E;
    const citations = (belief.disputed ? belief.heads : [head]).map((h) => cite(h.citation, h.evidence_span));
    return {
      answer: belief.disputed ? belief.heads.map((h) => h.value).join(' | ') : head.value,
      abstained: false,
      disputed: belief.disputed,
      confidence: conf,
      citations,
      evidence: score,
      latency_ms: latency,
      ...base,
    };
  }
  return abstain(nmOf());
}
