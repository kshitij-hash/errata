// packages/ingest/src/pipeline.ts — the write-path state machine for one history .
//
// S1 structural (zero LLM) → S3 extract → S4 prepare + conflict → S6 batched two-phase load, then
// write the lexicon. Runs are independent and idempotent (every write is a MERGE). The conflict
// step is deterministic (temporal rule) by default, or uses the LLM judge when one is supplied.

import type { EdgeBatch, GraphClient, NodeBatch } from '@errata/graph';
import type { History } from './reader.js';
import type { Extractor } from './extract.js';
import { buildStructural } from './structural.js';
import { buildClaims, prepareClaims, resolveConflicts } from './build.js';
import type { PreparedClaim, RevisionEdgeSpec } from './build.js';
import { resolveConflictsWithJudge } from './llm.js';
import type { ConflictJudge } from './llm.js';
import { EMPTY_ALIASES } from './aliases.js';
import type { AliasGenerator } from './aliases.js';
import { buildLexicon, writeLexicon } from './lexicon.js';

export interface AssembleResult {
  nodes: NodeBatch[];
  edges: EdgeBatch[];
  entities: { norm: string; id: number; key: string; etype: string }[];
  counts: { sessions: number; turns: number; salient: number; claims: number; entities: number; supersedes: number; contradicts: number; supports: number };
}

function assembleFrom(history: History, prepared: PreparedClaim[], revision: RevisionEdgeSpec[], opts: { model: string; runId: string; ingestTime: number }): AssembleResult {
  const structural = buildStructural(history, opts.runId, opts.ingestTime);
  const cb = buildClaims(history, prepared, revision, opts.model, opts.runId, opts.ingestTime);
  const count = (t: string): number => revision.filter((r) => r.type === t).length;
  return {
    nodes: [...structural.nodes, ...cb.nodes],
    edges: [...structural.edges, ...cb.edges],
    entities: cb.entities,
    counts: {
      sessions: structural.counts.sessions,
      turns: structural.counts.turns,
      salient: structural.counts.salient,
      claims: prepared.length,
      entities: cb.entities.length,
      supersedes: count('SUPERSEDES'),
      contradicts: count('CONTRADICTS'),
      supports: count('SUPPORTS'),
    },
  };
}

/** Pure assembly of all node/edge batches for a history (deterministic conflict; no I/O). */
export function assemble(history: History, extracted: Awaited<ReturnType<Extractor['extract']>>, opts: { model: string; runId: string; ingestTime: number }): AssembleResult {
  const prepared = prepareClaims(history, extracted);
  return assembleFrom(history, prepared, resolveConflicts(prepared), opts);
}

export interface IngestOptions {
  extractor: Extractor;
  judge?: ConflictJudge; // when present, the LLM judge replaces the temporal rule (credit-gated)
  /** when present, one extra extractor-model call per history bakes entity/attribute aliases into
   *  the lexicon (G5). Absent → the lexicon is exactly the literal-name index it always was. */
  aliases?: AliasGenerator;
  ingestTime?: number;
  runId?: string;
  lexiconDir?: string;
}
export interface IngestSummary extends AssembleResult {
  historyId: string;
  runId: string;
  nodeBatches: number;
  edgeBatches: number;
  bookmark: string[];
  lexiconPath: string;
}

export async function ingestHistory(client: GraphClient, history: History, opts: IngestOptions): Promise<IngestSummary> {
  const ingestTime = opts.ingestTime ?? Math.floor(Date.now() / 1000);
  const runId = opts.runId ?? `r-${history.historyId}-${ingestTime}`;
  const extracted = await opts.extractor.extract(history);
  const prepared = prepareClaims(history, extracted);
  const revision = opts.judge ? await resolveConflictsWithJudge(prepared, opts.judge) : resolveConflicts(prepared);
  const a = assembleFrom(history, prepared, revision, { model: opts.extractor.model, runId, ingestTime });
  const { nodeBatches, edgeBatches } = await client.loadTwoPhase(a.nodes, a.edges);
  // structural-only histories have no entities → no lexicon (keeps the ask path from anchoring on
  // nothing, and avoids writing 500 empty files during a full-corpus structural pass).
  let lexiconPath = '';
  if (a.entities.length > 0) {
    const attributes = [...new Set(prepared.map((c) => c.attribute))];
    const aliasSets = opts.aliases
      ? await opts.aliases.generate(history.historyId, a.entities.map((e) => e.norm), attributes)
      : EMPTY_ALIASES;
    lexiconPath = writeLexicon(
      opts.lexiconDir ?? 'var/lexicon',
      buildLexicon(history.historyId, a.entities, attributes, aliasSets),
    );
  }
  return { ...a, historyId: history.historyId, runId, nodeBatches, edgeBatches, bookmark: client.bookmark, lexiconPath };
}
