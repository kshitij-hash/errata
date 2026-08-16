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

const ClaimItemSchema = z.object({
  subject: z.string(),
  attribute: z.string(),
  value: z.string(),
  polarity: z.enum(['AFFIRM', 'NEGATE']),
  event_time_iso: z.string(), // '' if unknown
  session_id: z.string(),
  turn_idx: z.number().int(),
  evidence_span: z.string(),
});
export const ExtractSchema = z.object({ claims: z.array(ClaimItemSchema) });
// loose request schema so ONE malformed claim salvages the batch — each item is validated per-claim.
const LooseExtractSchema = z.object({ claims: z.array(z.unknown()) });

const EXTRACT_SYSTEM = [
  'Extract durable personal facts stated by the user as claims.',
  'Each claim: subject (usually "the user"), a snake_case attribute (e.g. employer, city_of_residence,',
  'mortgage_preapproval_amount), a value, polarity AFFIRM or NEGATE, event_time_iso (YYYY-MM-DD or ""),',
  'and the session_id + turn_idx it came from (copy them from the turn header), and a verbatim',
  'evidence_span (<=160 chars). Only extract explicitly stated facts. Return {claims:[...]}.',
].join(' ');

const BATCH = 12;
// independent extraction batches in flight per history; ledger writes are lock-free appends and
// the graph write happens after ALL batches return, so concurrency here is safe.
const EXTRACT_CONCURRENCY = 6;

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
    const valid = new Set(turns.map((t) => `${t.sessionId}:${t.turn.turnIdx}`));
    const batches: (typeof turns)[] = [];
    for (let i = 0; i < turns.length; i += BATCH) batches.push(turns.slice(i, i + BATCH));

    // Batches are independent one-shot calls; run up to EXTRACT_CONCURRENCY at a time. Results land
    // in per-batch slots so claim order stays deterministic regardless of completion order.
    const slots: unknown[][] = batches.map(() => []);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const idx = next++;
        if (idx >= batches.length) return;
        const batch = batches[idx]!;
        const listing = batch
          .map((b) => `[session_id=${b.sessionId} turn_idx=${b.turn.turnIdx} date=${b.dateIso} role=${b.turn.role}] ${b.turn.text}`)
          .join('\n');
        try {
          const res = await this.completer.complete({
            role: 'extractor',
            history_id: history.historyId,
            unit_id: `${batch[0]!.sessionId}:${batch[0]!.turn.turnIdx}..${batch.at(-1)!.turn.turnIdx}`,
            run_id: this.runId,
            // request with the STRICT schema — OpenAI strict mode rejects Loose's `items:{}` with a
            // 400 on every unit (G2 finding). The response is still salvaged per-claim below.
            schema: ExtractSchema,
            schemaName: 'claims',
            messages: [
              { role: 'system', content: EXTRACT_SYSTEM },
              { role: 'user', content: listing },
            ],
          });
          const parsed = LooseExtractSchema.safeParse(res.json);
          slots[idx] = parsed.success ? parsed.data.claims : [];
        } catch {
          // an API/parse failure drops THIS batch only, never the whole history
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(EXTRACT_CONCURRENCY, batches.length) }, worker));

    const out: ExtractedClaim[] = [];
    for (const claimsRaw of slots) {
      for (const raw of claimsRaw) {
        const c = ClaimItemSchema.safeParse(raw); // a malformed claim drops only itself (P2-13)
        if (!c.success) continue;
        if (!valid.has(`${c.data.session_id}:${c.data.turn_idx}`)) continue; // reject a hallucinated citation
        out.push({
          subject: c.data.subject,
          attribute: c.data.attribute,
          value: c.data.value,
          polarity: c.data.polarity,
          eventTimeIso: c.data.event_time_iso,
          sessionId: c.data.session_id,
          turnIdx: c.data.turn_idx,
          evidenceSpan: c.data.evidence_span.slice(0, 160),
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
            history_id: historyId,
            subject: incumbent.subjectNorm,
            attribute: incumbent.attribute,
            arity: incumbent.arity,
            incumbent: { claim_id: incumbent.claimId, value: incumbent.value, event_time_iso: incumbent.eventTimeIso, time_basis: incumbent.timeBasis, confidence: incumbent.confidence, evidence_span: incumbent.evidenceSpan },
            candidate: { claim_id: candidate.claimId, value: candidate.value, event_time_iso: candidate.eventTimeIso, time_basis: candidate.timeBasis, confidence: candidate.confidence, evidence_span: candidate.evidenceSpan },
          }),
        },
      ],
    });
    return JudgeSchema.parse(res.json);
  };
}

/** Map a judge verdict to a revision edge, or null when there is no relation (spec 31 §3.5). The
 *  claim is still appended by build.ts; only the edge is withheld. */
export function verdictToEdge(v: JudgeVerdict, candidate: PreparedClaim, head: PreparedClaim): RevisionEdgeSpec | null {
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
    provenance: 'INFERRED',
  });
  if (v.same_attribute === false || v.relation === 'UNRELATED') return null; // no revision edge (P1-8)
  if (v.confidence < 0.55) return mk('CONTRADICTS', 'LOW_CONF', Math.max(v.confidence, 0.1));
  if (v.relation === 'SUPPORTS') return mk('SUPPORTS', 'OK', v.confidence);
  if (v.relation === 'CONTRADICTS') return mk('CONTRADICTS', 'OK', v.confidence);
  // SUPERSEDES — downgrade to CONTRADICTS when the model OR the claims' own event_times say the
  // incumbent is actually newer (do not trust the model's temporal_order alone; spec 31 §3.5 / P2-11).
  const dataIncumbentNewer = head.eventTime > -1 && candidate.eventTime > -1 && candidate.eventTime < head.eventTime;
  if (v.temporal_order === 'INCUMBENT_NEWER' || dataIncumbentNewer) return mk('CONTRADICTS', 'LOW_CONF', v.confidence);
  return mk('SUPERSEDES', 'OK', v.confidence);
}

/** Async conflict resolution using the LLM judge for FUNCTIONAL-differ cases (spec 31 §3.5). */
export async function resolveConflictsWithJudge(prepared: PreparedClaim[], judge: ConflictJudge): Promise<RevisionEdgeSpec[]> {
  const edges: RevisionEdgeSpec[] = [];
  const groups = new Map<string, PreparedClaim[]>();
  for (const c of prepared) {
    const k = `${c.subjectNorm}\u0000${c.attribute}`; // NUL separator (matches build.ts) — no space collisions
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
        if (target) edges.push(edge('SUPERSEDES', c, target, 'NONE', 'negation supersedes member', 0.7, 'INFERRED'));
      }
      continue;
    }
    let head = sorted[0]!;
    for (let i = 1; i < sorted.length; i++) {
      const cur = sorted[i]!;
      if (cur.valueNorm === head.valueNorm) {
        edges.push(edge('SUPPORTS', cur, head, 'NONE', 'same value corroborates', cur.confidence, 'EXTRACTED'));
        continue;
      }
      let e: RevisionEdgeSpec | null;
      try {
        e = verdictToEdge(await judge(head, cur), cur, head);
      } catch (err) {
        // 31 §3.5 uncertainty: never abort the ingest. Unparseable-after-repair → UNPARSED/0.15;
        // unreachable (API backoff / budget trip) → UNJUDGED/0.10. Always append a CONTRADICTS.
        const unparsed = /schema|parse|json/i.test(String((err as { message?: string })?.message ?? err));
        e = {
          type: 'CONTRADICTS', newerKey: cur.claimKey, newerId: cur.claimId, olderKey: head.claimKey, olderId: head.claimId,
          judge_status: unparsed ? 'UNPARSED' : 'UNJUDGED', judge_model: 'judge',
          rationale: unparsed ? 'judge output unparseable after repair' : 'judge unavailable (api/budget)',
          confidence: unparsed ? 0.15 : 0.1, provenance: 'INFERRED',
        };
      }
      if (e) {
        edges.push(e);
        if (e.type === 'SUPERSEDES') head = cur; // the chain advances only on a real supersession
      }
    }
  }
  return edges;
}

function edge(type: RevisionEdgeSpec['type'], newer: PreparedClaim, older: PreparedClaim, judge_status: string, rationale: string, confidence: number, provenance: 'EXTRACTED' | 'INFERRED'): RevisionEdgeSpec {
  return { type, newerKey: newer.claimKey, newerId: newer.claimId, olderKey: older.claimKey, olderId: older.claimId, judge_status, judge_model: '', rationale, confidence, provenance };
}
