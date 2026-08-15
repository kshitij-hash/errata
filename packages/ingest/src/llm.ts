// packages/ingest/src/llm.ts — the credit-gated extraction + conflict-judge path (spec 31 §3.5, §6).
//
// These implement the SAME `Extractor` interface and conflict seam as the deterministic path, so the
// write path is unchanged. They call OpenRouter via @errata/llm (every call writes the ledger).
// Real execution is blocked until credits are confirmed; the wiring is unit-tested with a mock
// completer so it is proven without spend.

import { z } from 'zod';
import type { History, Turn } from './reader.js';
import { isSalient } from './text.js';
import type { ExtractedClaim, Extractor } from './extract.js';
import type { PreparedClaim, RevisionEdgeSpec } from './build.js';

/** Structural view of @errata/llm's OpenRouterClient.complete — lets tests inject a mock. */
export interface Completer {
  complete(args: {
    role: string;
    unit_id?: string;
    history_id?: string;
    run_id?: string;
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
    schema?: z.ZodType;
    schemaName?: string;
  }): Promise<{ text: string; json?: unknown }>;
}

// ---- extraction ----

const ExtractSchema = z.object({
  claims: z.array(
    z.object({
      subject: z.string(),
      attribute: z.string(),
      value: z.string(),
      polarity: z.enum(['AFFIRM', 'NEGATE']),
      event_time_iso: z.string(), // '' if unknown
      session_id: z.string(),
      turn_idx: z.number().int(),
      evidence_span: z.string(),
    }),
  ),
});

const EXTRACT_SYSTEM = [
  'Extract durable personal facts stated by the user as claims.',
  'Each claim: subject (usually "the user"), a snake_case attribute (e.g. employer, city_of_residence,',
  'mortgage_preapproval_amount), a value, polarity AFFIRM or NEGATE, event_time_iso (YYYY-MM-DD or ""),',
  'and the session_id + turn_idx it came from (copy them from the turn header), and a verbatim',
  'evidence_span (<=160 chars). Only extract explicitly stated facts. Return {claims:[...]}.',
].join(' ');

const BATCH = 12;

function salientTurns(history: History): { sessionId: string; dateIso: string; turn: Turn }[] {
  const out: { sessionId: string; dateIso: string; turn: Turn }[] = [];
  for (const s of history.sessions) {
    let firstUser = true;
    for (const t of s.turns) {
      const isFirstUser = firstUser && t.role === 'user';
      if (t.role === 'user') firstUser = false;
      if (isSalient(t, isFirstUser)) out.push({ sessionId: s.sessionId, dateIso: s.dateIso, turn: t });
    }
  }
  return out;
}

export class LlmExtractor implements Extractor {
  readonly model: string;
  private readonly completer: Completer;
  private readonly runId: string;
  constructor(completer: Completer, model = 'llm-extractor', runId = 'run') {
    this.completer = completer;
    this.model = model;
    this.runId = runId;
  }

  async extract(history: History): Promise<ExtractedClaim[]> {
    const turns = salientTurns(history);
    const out: ExtractedClaim[] = [];
    const valid = new Set(turns.map((t) => `${t.sessionId}:${t.turn.turnIdx}`));
    for (let i = 0; i < turns.length; i += BATCH) {
      const batch = turns.slice(i, i + BATCH);
      const listing = batch
        .map((b) => `[session_id=${b.sessionId} turn_idx=${b.turn.turnIdx} date=${b.dateIso} role=${b.turn.role}] ${b.turn.text}`)
        .join('\n');
      const res = await this.completer.complete({
        role: 'extractor',
        history_id: history.historyId,
        unit_id: `${batch[0]!.sessionId}:${batch[0]!.turn.turnIdx}..${batch.at(-1)!.turn.turnIdx}`,
        run_id: this.runId,
        schema: ExtractSchema,
        schemaName: 'claims',
        messages: [
          { role: 'system', content: EXTRACT_SYSTEM },
          { role: 'user', content: listing },
        ],
      });
      const parsed = ExtractSchema.safeParse(res.json);
      if (!parsed.success) continue; // one repair retry already happened in the client; drop the batch
      for (const c of parsed.data.claims) {
        if (!valid.has(`${c.session_id}:${c.turn_idx}`)) continue; // reject a hallucinated citation
        out.push({
          subject: c.subject,
          attribute: c.attribute,
          value: c.value,
          polarity: c.polarity,
          eventTimeIso: c.event_time_iso,
          sessionId: c.session_id,
          turnIdx: c.turn_idx,
          evidenceSpan: c.evidence_span.slice(0, 160),
          confidence: 0.8,
        });
      }
    }
    return out;
  }
}

// ---- conflict judge (spec 31 §3.5) ----

export const JudgeSchema = z.object({
  relation: z.enum(['SUPERSEDES', 'CONTRADICTS', 'SUPPORTS', 'UNRELATED']),
  confidence: z.number(),
  same_attribute: z.boolean(),
  temporal_order: z.enum(['CANDIDATE_NEWER', 'INCUMBENT_NEWER', 'UNKNOWN']),
  rationale: z.string(),
});
export type JudgeVerdict = z.infer<typeof JudgeSchema>;

const JUDGE_SYSTEM =
  'You judge whether a candidate claim supersedes, contradicts, supports, or is unrelated to an incumbent belief about the same subject/attribute. Consider explicit dates. Return the strict JSON schema.';

export type ConflictJudge = (incumbent: PreparedClaim, candidate: PreparedClaim) => Promise<JudgeVerdict>;

export function makeJudge(completer: Completer, historyId: string, runId = 'run'): ConflictJudge {
  return async (incumbent, candidate) => {
    const res = await completer.complete({
      role: 'judge',
      history_id: historyId,
      unit_id: `${candidate.turnId}`,
      run_id: runId,
      schema: JudgeSchema,
      schemaName: 'verdict',
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        {
          role: 'user',
          content: JSON.stringify({
            subject: incumbent.subjectNorm,
            attribute: incumbent.attribute,
            incumbent: { value: incumbent.value, event_time_iso: incumbent.eventTimeIso, evidence_span: incumbent.evidenceSpan },
            candidate: { value: candidate.value, event_time_iso: candidate.eventTimeIso, evidence_span: candidate.evidenceSpan },
          }),
        },
      ],
    });
    return JudgeSchema.parse(res.json);
  };
}

/** Map a judge verdict to a revision edge (spec 31 §3.5 mapping + uncertainty tables). Never drops. */
export function verdictToEdge(v: JudgeVerdict, candidate: PreparedClaim, head: PreparedClaim): RevisionEdgeSpec {
  const mk = (type: RevisionEdgeSpec['type'], judge_status: string, confidence: number): RevisionEdgeSpec => ({
    type,
    newerKey: candidate.claimKey,
    newerId: candidate.claimId,
    olderKey: head.claimKey,
    olderId: head.claimId,
    judge_status,
    judge_model: 'judge',
    rationale: v.rationale.slice(0, 200),
    confidence,
  });
  if (v.same_attribute === false || v.relation === 'UNRELATED') return mk('CONTRADICTS', 'OK', Math.max(v.confidence, 0.1)); // appended, flagged, but not a supersession
  if (v.confidence < 0.55) return mk('CONTRADICTS', 'LOW_CONF', Math.max(v.confidence, 0.1));
  if (v.relation === 'SUPPORTS') return mk('SUPPORTS', 'OK', v.confidence);
  if (v.relation === 'CONTRADICTS') return mk('CONTRADICTS', 'OK', v.confidence);
  // SUPERSEDES
  if (v.temporal_order === 'INCUMBENT_NEWER') return mk('CONTRADICTS', 'LOW_CONF', v.confidence); // downgrade
  return mk('SUPERSEDES', 'OK', v.confidence);
}

/** Async conflict resolution using the LLM judge for FUNCTIONAL-differ cases (spec 31 §3.5). */
export async function resolveConflictsWithJudge(prepared: PreparedClaim[], judge: ConflictJudge): Promise<RevisionEdgeSpec[]> {
  const edges: RevisionEdgeSpec[] = [];
  const groups = new Map<string, PreparedClaim[]>();
  for (const c of prepared) {
    const k = `${c.subjectNorm} ${c.attribute}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
  }
  const byEvent = (a: PreparedClaim, b: PreparedClaim): number => a.eventTime - b.eventTime || a.claimId - b.claimId;
  for (const group of groups.values()) {
    const sorted = group.slice().sort(byEvent);
    if (sorted[0]!.arity !== 'FUNCTIONAL') {
      // MULTI is deterministic (negation supersedes a member); reuse the sync logic shape
      const members = sorted.filter((c) => c.polarity === 'AFFIRM');
      for (const c of sorted) {
        if (c.polarity !== 'NEGATE') continue;
        const target = members.find((m) => m.valueNorm === c.valueNorm && m.eventTime <= c.eventTime);
        if (target) edges.push(edge('SUPERSEDES', c, target, 'NONE', 'negation supersedes member', 0.7));
      }
      continue;
    }
    let head = sorted[0]!;
    for (let i = 1; i < sorted.length; i++) {
      const cur = sorted[i]!;
      if (cur.valueNorm === head.valueNorm) {
        edges.push(edge('SUPPORTS', cur, head, 'NONE', 'same value corroborates', cur.confidence));
        continue;
      }
      const v = await judge(head, cur);
      const e = verdictToEdge(v, cur, head);
      edges.push(e);
      if (e.type === 'SUPERSEDES') head = cur; // the chain advances only on a real supersession
    }
  }
  return edges;
}

function edge(type: RevisionEdgeSpec['type'], newer: PreparedClaim, older: PreparedClaim, judge_status: string, rationale: string, confidence: number): RevisionEdgeSpec {
  return { type, newerKey: newer.claimKey, newerId: newer.claimId, olderKey: older.claimKey, olderId: older.claimId, judge_status, judge_model: '', rationale, confidence };
}
