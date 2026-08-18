// apps/api/src/query.ts — orchestration: builder → driver → core fold → response shape.
// Read-only. Every answer carries a citation with a positional turn_index (hard rule 3, integration seam).
// Responses follow contract v1.1.

import { randomUUID } from 'node:crypto';
import {
  claimsForEntities,
  claimsForEntityAttribute,
  claimsForHistory,
  enumerateChain,
  keys,
  revisionEdgesForEntity,
  spPaths,
  vid,
} from '@errata/graph';
import type { GraphClient, Stmt } from '@errata/graph';
import {
  attributeSynonyms,
  bigrams,
  contentTokens,
  coverage,
  decide,
  diffChain,
  idfWeights,
  isRegistered,
  lexTokens,
  buildTimeline,
  rankByRelevance,
  renderTimeline,
  resolveAsOf,
  resolveBelief,
  scoreEvidence,
  stem,
  temporalIntent,
  tokenF1,
} from '@errata/core';
import { ANSWER_PROMPT } from '@errata/core';
import type { BeliefResult, BeliefValue, ClaimRow, Citation, RevisionEdgeRow, TimeAxis } from '@errata/core';
import { beatFixture, config } from './deps.js';

/** local copy of the ingest normalizer (asserted in sync by app.spec); avoids an api→ingest edge. */
export function normText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
/** attributes are stored canonically; normalize a query attribute the way the extractor did. */
export function normAttr(raw: string): string {
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

  // cross-validate the in-memory chain against the graph (the pathCount-lie guard):
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
  /** v1.1 additive (optional): the resolved belief's coordinates — the UI needs them to open the
   * same chain on /belief and /diff without guessing the subject the fold actually used. */
  subject?: string;
  attribute?: string;
  /** v1.1 additive (optional): the struck predecessors of the answered belief, so the answer card
   * can show what it supersedes without a second round trip. Empty when nothing was superseded. */
  superseded?: unknown[];
  /**
   * v1.1 additive (optional): the HEAD CLAIM's own confidence — a different quantity from
   * `confidence`, which is the calibrated answer-EVIDENCE score E (evidence-scoring design).
   *
   * Diagnosis. The flagship answer scored `confidence 0.44` and read as weak. The calibration is
   * correct and no weight is buggy; the two numbers are simply on different scales, and one label
   * was doing both jobs. E = 0.3a + 0.3s + 0.15c + 0.15p + 0.1d with the weights fixed a priori;
   * on the flagship a = 2/7 (only 2 of 7 content tokens name an entity), s = 1/3 (token-F1 of a
   * 12-word question against `mortgage_preapproval_amount $400,000`), c = 0.72 (the head claim's
   * own confidence, judge factor 1.0 — NOT floored: judge_status is NONE, and only UNJUDGED
   * halves it), p = 1/3 (corroboration IS counted, but a fact stated once and later revised has
   * exactly one citing turn), d = 1. Every component is doing what the scoring design says it should, and E =
   * 0.4437 sits comfortably above τ = 0.35. A well-cited single-statement fact simply cannot
   * approach 1.0 on this scale: a, s and p are bounded by question-token coverage and restatement
   * count, none of which measure how sure we are of the claim.
   *
   * The fix is therefore to stop labelling E "confidence" on its own. Both numbers ship, labelled:
   * the answer card reads "claim .72 · evidence .44". Nothing about the calibration changed.
   */
  claim_confidence?: number;
  corroboration?: number;
  cost: number;
  usage: { prompt_tokens: number; completion_tokens: number };
  cypher: Cypher[];
  vector_baseline: unknown;
  trace_id: string;
  evidence: unknown;
  nearest_miss?: unknown[];
  latency_ms: number;
  /** DIAGNOSTIC ONLY, opt-in via `debug: true` on POST /api/ask. Absent otherwise, so the eval's
   *  contract-v1.1 rows are byte-identical whether or not this exists. Written for
   *  `eval/failure_review.py`: it needs to know WHY a row abstained, not just that it did. */
  trace?: AskTrace;
}

/** One ask, opened up: what the front door resolved, what material the synthesis saw, and the
 *  exact gate that produced the outcome. See `AskResult.trace`. */
export interface AskTrace {
  tokens: string[];
  matched_tokens: string[];
  unmatched_tokens: string[];
  first_person: boolean;
  anchors: number;
  anchors_resolved: number;
  claim_rows: number;
  attributes: string[];
  /** attributes the write-side aliases say the question is asking about (attribute-first) */
  focus_attributes: string[];
  best_attribute: string | null;
  best_score: number;
  material: { attribute: string; value: string; s: number; session_id: string; turn_index: number; span: string }[];
  /** the MATERIAL exactly as synthesis saw it — span-grouped lines plus, on a temporal question,
   *  the computed timeline. `material` above is the ranked rows; this is the rendered text, which
   *  is what actually has to be right. Diagnostic only; never sent when `debug` is false. */
  context: string;
  decision: string;
  synth: 'none' | 'insufficient' | 'answer' | 'empty';
  /** the gate that produced an abstention, or null when the ask answered. */
  abstain_reason: 'no_anchor' | 'no_claim_fit' | 'synth_insufficient' | 'below_tau' | null;
  /** every claim in the history (bounded scan) — the extraction-gap denominator. */
  history_claims: { attribute: string; value: string; span: string }[];
}

/** The one LLM seam in the answer path (v2 synthesis). Injected so vitest never touches an LLM
 * (hard rule 6) and the deterministic fold remains the complete fallback when no key is set. */
export interface AnswerCompleter {
  complete(args: {
    role: string;
    history_id: string;
    unit_id: string;
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
    maxTokens?: number;
    temperature?: number;
    reasoningEnabled?: boolean;
  }): Promise<{ text: string; usage: { prompt_tokens: number; completion_tokens: number }; cost_usd: number }>;
}

export interface AskOptions {
  completer?: AnswerCompleter;
  questionDate?: string;
  /** attach `trace` to the result (extra reads; diagnostic replays only, never the demo path). */
  debug?: boolean;
}

/** The lexicon shape the ask path reads (deps.ts owns loading and caching it). */
export interface AskLexicon {
  self: number[];
  terms: Record<string, number[]>;
  attrTerms?: Record<string, string[]>;
  attrAliases?: Record<string, string[]>;
}

/**
 * Last-resort anchors when nothing in the question names an entity and the history has no SELF:
 * the entity ids the lexicon mentions under the most terms, which is a proxy for mention_count
 * without a second read. Deterministic (ties by first appearance), id-pinned, never a scan.
 */
function fallbackAnchors(lex: AskLexicon, k: number): number[] {
  const weight = new Map<number, number>();
  const order = new Map<number, number>();
  let i = 0;
  for (const ids of Object.values(lex.terms)) {
    for (const id of ids) {
      weight.set(id, (weight.get(id) ?? 0) + 1);
      if (!order.has(id)) order.set(id, i++);
    }
  }
  return [...weight.entries()]
    .sort((a, b) => b[1] - a[1] || (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0))
    .slice(0, k)
    .map(([id]) => id);
}

export async function askQuery(client: GraphClient, historyId: string, question: string, lex: AskLexicon | null, opts: AskOptions = {}): Promise<AskResult> {
  const t0 = performance.now();
  const cypher: Cypher[] = []; // always surfaced (the demo shows the Cypher on screen)
  const tokens = contentTokens(question);
  // the stemmed / number-canonicalized view of the same question — everything that MATCHES uses
  // these; `tokens` stays the raw content tokens because the calibrated E score is defined on them.
  const qLex = lexTokens(question);
  const qGrams = bigrams(qLex);
  const firstPerson = /\b(i|me|my|myself|mine|we|our)\b/i.test(question.toLowerCase());
  const trace_id = randomUUID();
  // the losing pane of demo beat 1: what a vector store returns for this question (served from the
  // committed bge-small fixture). Only attached when the question matches the fixture's query.
  const beat = beatFixture();
  // a vector store returns the HIGHEST-cosine candidate — which in the beat is the *superseded*
  // claim, the whole point of the demo (similarity ranks the stale fact above the current one).
  const top = beat?.candidates.slice().sort((a, b) => b.cosine - a.cosine)[0];
  const vector_baseline =
    beat && top && tokenF1(tokens, contentTokens(beat.query)) >= 0.5
      ? { answer: top.text, cosine: top.cosine, citation: top.citation ?? null, embedder: beat.embedder }
      : null;
  const base = { cost: 0, usage: { prompt_tokens: 0, completion_tokens: 0 }, cypher, vector_baseline, trace_id };

  // ---- anchor resolution (anchor resolution, step 0) -----------------------------------------------
  //
  // SELF IS ALWAYS AN ANCHOR. It used to be added only when the question read as first-person, and
  // the taxonomy showed what that cost: a question naming one rare entity narrowed retrieval to
  // that entity's claims alone (one case reached the model with 1 claim out of 147 in the history),
  // and a question naming nothing at all resolved to zero anchors and abstained without a read.
  // Anchoring on the history's own subject can only ADD rows; the ranker decides what survives.
  const anchorSet = new Set<number>();
  const selfFirst: number[] = [];
  const matchedTokens: string[] = [];
  const unmatchedTokens: string[] = [];
  let resolved = 0;
  if (lex) for (const id of lex.self) if (!selfFirst.includes(id)) selfFirst.push(id);
  const hit = (term: string): number[] | undefined => {
    const ids = lex?.terms[term];
    return ids && ids.length ? ids : undefined;
  };
  for (const t of tokens) {
    // raw token, then its stem — the lexicon indexes both surface and stemmed forms.
    const ids = hit(t) ?? hit(stem(t));
    if (ids) {
      for (const id of ids) anchorSet.add(id);
      resolved++;
      matchedTokens.push(t);
    } else if (FIRST_PERSON.has(t)) {
      resolved++;
      matchedTokens.push(t);
    } else {
      unmatchedTokens.push(t);
    }
  }
  // multi-word entity names ("st mary s church") are indexed whole; probe the question's bigrams.
  for (const g of qGrams) {
    const ids = hit(g);
    if (ids) for (const id of ids) anchorSet.add(id);
  }
  // attribute-first: which stored attributes could this question be ASKING about (write-side
  // aliases, matched deterministically)? Used to rank, and to salvage an anchorless question.
  const attrScore = new Map<string, number>();
  for (const term of [...qLex, ...qGrams]) {
    for (const attribute of lex?.attrTerms?.[term] ?? []) {
      attrScore.set(attribute, (attrScore.get(attribute) ?? 0) + (term.includes(' ') ? 2 : 1));
    }
  }
  const attrRanked = [...attrScore.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const topAttrScore = attrRanked[0]?.[1] ?? 0;
  const focusAttrs = new Set(attrRanked.filter(([, v]) => v === topAttrScore && v > 0).map(([k]) => k));

  // SELF first so it is never the entry the 8-anchor cap drops.
  const anchors = [...new Set([...selfFirst, ...anchorSet])].slice(0, 8);
  // no entity named AND no SELF in this history: fall back to its most-mentioned entities rather
  // than refusing without a read (the attribute match, if any, still steers the ranking).
  if (anchors.length === 0 && lex && focusAttrs.size > 0) anchors.push(...fallbackAnchors(lex, 8));
  const anchorsResolved = Math.min(resolved, tokens.length);

  // diagnostic replay only: the whole history's claims, so the taxonomy can separate a ranking
  // miss (the claim exists but never reached the material) from an extraction gap (it never existed).
  const historyClaims = opts.debug
    ? (await run(client, claimsForHistory(historyId))).map((r) => ({
        attribute: String(r.attribute),
        value: String(r.value),
        span: String(r.evidence_span ?? ''),
      }))
    : [];
  const dbg = {
    best_attribute: null as string | null,
    best_score: 0,
    material: [] as AskTrace['material'],
    claim_rows: 0,
    attributes: [] as string[],
    focus_attributes: [] as string[],
    context: '',
    synth: 'none' as AskTrace['synth'],
  };
  const traceOf = (decision: string, reason: AskTrace['abstain_reason']): { trace?: AskTrace } =>
    opts.debug
      ? {
          trace: {
            tokens, matched_tokens: matchedTokens, unmatched_tokens: unmatchedTokens,
            first_person: firstPerson, anchors: anchors.length, anchors_resolved: anchorsResolved,
            claim_rows: dbg.claim_rows, attributes: dbg.attributes,
            focus_attributes: dbg.focus_attributes,
            best_attribute: dbg.best_attribute, best_score: dbg.best_score, material: dbg.material,
            context: dbg.context,
            decision, synth: dbg.synth, abstain_reason: reason, history_claims: historyClaims,
          },
        }
      : {};

  const abstain = (nearest: unknown[], reason: AskTrace['abstain_reason']): AskResult => {
    const score = scoreEvidence({ contentTokens: tokens, anchorsResolved, hasTimeConstraint: hasTimeConstraint(question), timeConstraintViolated: false }, [], config.tau);
    return { answer: null, abstained: true, confidence: score.E, citations: [], nearest_miss: nearest, evidence: score, latency_ms: +(performance.now() - t0).toFixed(1), ...base, ...traceOf('ABSTAIN', reason) };
  };

  if (anchors.length === 0) return abstain([], 'no_anchor');

  const claimRows = await run(client, claimsForEntities(anchors, historyId), cypher);

  // ---- relevance: ONE scorer, used for the material, the nearest misses and the answer attribute.
  //
  // Replaces `tokenF1(question, attribute + " " + value)`. Three things changed and each was a
  // measured miss (see eval/out/failure-taxonomy.md): the EVIDENCE SPAN is scored (it carries the
  // transcript's own wording, which is what a question echoes); coverage is IDF-weighted and
  // asymmetric (a claim is rewarded for covering the ask, not punished for being long); and a claim
  // whose attribute the write-side aliases say this question is asking about is boosted.
  const ATTR_FOCUS_BOOST = 0.25;
  /** attribute weight when picking the BELIEF's coordinates (the material uses W_BODY/W_ATTR). */
  const W_ATTR_LED = 0.7;
  const cands = claimRows.map((r, i) => {
    const attribute = String(r.attribute);
    const aliasWords = (lex?.attrAliases?.[attribute] ?? []).join(' ');
    return {
      attribute,
      value: String(r.value),
      attrTokens: lexTokens(`${attribute.replace(/_/g, ' ')} ${attributeSynonyms(attribute).join(' ')} ${aliasWords}`),
      bodyTokens: lexTokens(`${attribute.replace(/_/g, ' ')} ${String(r.value)} ${String(r.evidence_span ?? '')}`),
      focus: focusAttrs.has(attribute),
      _i: i,
      _row: r,
    };
  });
  const ranked = rankByRelevance(qLex, cands, cands.length)
    .map((c) => ({ ...c, s: +(c.s + (c.focus ? ATTR_FOCUS_BOOST : 0)).toFixed(6) }))
    .sort((a, b) => (b.s !== a.s ? b.s - a.s : a._i - b._i));

  const nmOf = (): unknown[] =>
    ranked.slice(0, 3).map((c) => ({
      attribute: c.attribute, value: c.value, s: c.s,
      citation: { session_id: String(c._row.session_id), turn_index: Number(c._row.turn_index) },
      span: c._row.evidence_span,
    }));

  // The MATERIAL is body-dominant (above); the BELIEF COORDINATES are not. Picking the belief from
  // `ranked[0]` regressed the flagship: "How much was I pre-approved for by Wells Fargo?" scores the
  // lender claim highest on body coverage — the question names the lender — and the answer card then
  // opened `mortgage_lender` with no struck predecessor instead of `mortgage_preapproval_amount`
  // with its $350,000. The question's head noun names the ATTRIBUTE, so the attribute term leads
  // here, mirroring the retired `attrFit`. Nothing about the material or the answer text depends on
  // this choice — only `subject`/`attribute`/`superseded`/`claim_confidence` and E's `s` do.
  const idfForBelief = idfWeights(cands.map((c) => c.bodyTokens));
  let bestCand: (typeof cands)[number] | undefined;
  let bestSc = 0;
  for (const c of cands) {
    const s =
      W_ATTR_LED * coverage(qLex, new Set(c.attrTokens), idfForBelief) +
      (1 - W_ATTR_LED) * coverage(qLex, new Set(c.bodyTokens), idfForBelief) +
      (c.focus ? ATTR_FOCUS_BOOST : 0);
    if (s > bestSc) {
      bestSc = s;
      bestCand = c;
    }
  }
  const best = (bestCand ?? ranked[0])?._row;
  if (!bestCand && ranked[0]) bestSc = ranked[0].s;
  dbg.claim_rows = claimRows.length;
  dbg.attributes = [...new Set(claimRows.map((r) => String(r.attribute)))];
  dbg.focus_attributes = [...focusAttrs];
  dbg.best_score = bestSc;
  dbg.best_attribute = best ? String(best.attribute) : null;
  if (!best) return abstain([], 'no_claim_fit');

  // resolve the belief for the chosen attribute at the best claim's own SUBJECT entity.
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

  // `fit` hands the calibrated score the SAME relevance number the material ranking used, instead
  // of recomputing a token-F1 that the taxonomy showed is near-zero on most real questions.
  const cand = head ? [{ attribute: bestAttr, value: head.value, registryMatched: isRegistered(bestAttr), fit: Math.min(1, bestSc), headConfidence: head.confidence, judgeConfidence: head.judge_status === 'UNJUDGED' ? 0.5 : 1.0, corroboration: head.corroboration }] : [];
  const score = scoreEvidence({ contentTokens: tokens, anchorsResolved, hasTimeConstraint: hasTimeConstraint(question), timeConstraintViolated: false }, cand, config.tau);
  const decision = decide(score, config.tau, belief.disputed);
  const latency = +(performance.now() - t0).toFixed(1);

  // ---- v2 synthesis: qwen composes the reply from graph-retrieved material -------------------
  // The eval measured the fold-only path at 8.3 overall vs ~46 for the baselines: the graph HAD
  // the evidence, but raw stored values + a τ gate on E lost on phrasing and abstained on 69%.
  // With a completer configured, the top-ranked claims become the MATERIAL for the shared
  // ANSWER_PROMPT (same model + prompt as every baseline arm — the parity gate's whole point) and
  // the LLM decides answer vs INSUFFICIENT_INFORMATION. No claims retrieved → still a $0 abstain.
  if (opts.completer) {
    // The material window was 12 claims out of a median 181 reachable, chosen by a score that was
    // zero for most of them — i.e. arbitrary. It is now `config.materialMax` claims chosen by the
    // relevance above. Even at 30 the prompt is ~1/60th of the full-context arm's.
    const window = ranked.slice(0, config.materialMax);
    if (window.length > 0) {
      const dateOf = (r: Record<string, unknown>): string => {
        const e = Number(r.event_time);
        return e > 0 ? new Date(e * 1000).toISOString().slice(0, 10) : 'undated';
      };
      const ordered = window.slice().sort((a, b) => Number(a._row.event_time) - Number(b._row.event_time));
      dbg.material = ordered.map((c) => ({
        attribute: c.attribute, value: c.value, s: c.s,
        session_id: String(c._row.session_id), turn_index: Number(c._row.turn_index),
        span: String(c._row.evidence_span ?? ''),
      }));

      // ---- span-grouped material -------------------------------------------------------------
      //
      // The evidence span — the transcript's own verbatim words — has been in the material since
      // v2 synthesis, and that is what lets an answer reproduce a name or a figure exactly. What
      // was NOT true is that each span appeared once: several claims are routinely extracted from
      // ONE sentence ("I earn 95k at Acme" → employer AND salary), and each of them printed the
      // whole span again. Measured over the comparison-150: 148 of 150 windows repeated at least
      // one span and 729 of 4,500 slots (16.2%) were duplicate quotes.
      //
      // So the span becomes the unit and its claims hang off it — one quote, every value that was
      // read out of it. No claim is dropped and no value is lost; the repetition is.
      const groups = new Map<string, { rows: typeof ordered; span: string; eventTime: number }>();
      for (const c of ordered) {
        const span = String(c._row.evidence_span ?? '');
        const key = `${String(c._row.session_id)} ${Number(c._row.turn_index)} ${span}`;
        const g = groups.get(key);
        if (g) g.rows.push(c);
        else groups.set(key, { rows: [c], span, eventTime: Number(c._row.event_time) });
      }
      const material = [...groups.values()]
        .map((g) => {
          const head = g.rows[0]!;
          const values = g.rows.map((c) => `${c.attribute.replace(/_/g, ' ')}: ${c.value}`).join(' | ');
          return `[${dateOf(head._row)}] ${values} (session ${String(head._row.session_id)}, turn ${Number(head._row.turn_index)}) — "${g.span}"`;
        })
        .join('\n');

      // ---- the graph does time, not the prompt ------------------------------------------------
      //
      // Temporal reasoning was the weakest named type (41.0% / 39). The dates were always in the
      // material; the ARITHMETIC over them was not — ordering, gaps, ages, elapsed spans were left
      // for the model to do in its head from a column of ISO strings. Every one of those is a
      // deterministic fold over `event_time`, which the graph stores on every claim, so the code
      // computes them and synthesis is left to phrase the result.
      //
      // Gated on a cheap lexical intent probe (no model call, hard rule 2), and it degrades rather
      // than invents: claims with `event_time = -1` are counted and never placed, and a window with
      // fewer than two dated claims renders no block at all.
      const timeSignal = temporalIntent(question);
      const timeline = timeSignal.temporal
        ? renderTimeline(
            buildTimeline(
              [...groups.values()].map((g) => ({
                eventTime: g.eventTime,
                attribute: '',
                value: g.rows.map((c) => `${c.attribute.replace(/_/g, ' ')}: ${c.value}`).join(' | '),
                sessionId: String(g.rows[0]!._row.session_id),
                turnIndex: Number(g.rows[0]!._row.turn_index),
              })),
              opts.questionDate ?? null,
            ),
            config.materialMax,
          )
        : '';
      const context = timeline ? `${material}\n${timeline}` : material;
      dbg.context = context;
      const prompt = ANSWER_PROMPT
        .replace('{question_date}', opts.questionDate ?? new Date().toISOString().slice(0, 10))
        .replace('{context}', context)
        .replace('{question}', question);
      const res = await opts.completer.complete({
        role: 'answer',
        history_id: historyId,
        unit_id: `ask:${trace_id.slice(0, 8)}`,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 300,
        temperature: 0,
        reasoningEnabled: false,
      });
      const text = res.text.trim();
      const paid = { ...base, cost: res.cost_usd, usage: res.usage };
      const synthLatency = +(performance.now() - t0).toFixed(1);
      if (text.startsWith('INSUFFICIENT_INFORMATION')) {
        dbg.synth = 'insufficient';
        return { answer: null, abstained: true, confidence: score.E, citations: [], nearest_miss: nmOf(), evidence: score, latency_ms: synthLatency, ...paid, ...traceOf('ABSTAIN', 'synth_insufficient') };
      }
      dbg.synth = text === '' ? 'empty' : 'answer';
      if (text !== '') {
        return {
          answer: text,
          abstained: false,
          disputed: belief.disputed,
          confidence: score.E,
          citations: window.slice(0, 3).map((c) => cite({ session_id: String(c._row.session_id), turn_index: Number(c._row.turn_index), claim_id: Number(c._row.claim_id) }, String(c._row.evidence_span ?? ''))),
          subject: subjectNorm || undefined,
          attribute: bestAttr,
          superseded: belief.superseded.map(shapeValue),
          claim_confidence: head?.confidence,
          corroboration: head?.corroboration,
          evidence: score,
          latency_ms: synthLatency,
          ...paid,
          ...traceOf('SYNTHESIS', null),
        };
      }
      // empty content from the model: fall through to the deterministic fold — never return ''.
    }
  }

  if ((decision === 'ANSWER' || decision === 'DISPUTED') && head) {
    const conf = belief.contested && !belief.disputed ? +(score.E * 0.7).toFixed(3) : score.E;
    const citations = (belief.disputed ? belief.heads : [head]).map((h) => cite(h.citation, h.evidence_span));
    return {
      answer: belief.disputed ? belief.heads.map((h) => h.value).join(' | ') : head.value,
      abstained: false,
      disputed: belief.disputed,
      confidence: conf,
      citations,
      subject: subjectNorm || undefined,
      attribute: bestAttr,
      superseded: belief.superseded.map(shapeValue),
      claim_confidence: head.confidence,
      corroboration: head.corroboration,
      evidence: score,
      latency_ms: latency,
      ...base,
      ...traceOf(decision, null),
    };
  }
  return abstain(nmOf(), 'below_tau');
}
