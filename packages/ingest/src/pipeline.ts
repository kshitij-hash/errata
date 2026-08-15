// packages/ingest/src/pipeline.ts — the write-path state machine for one history (spec 31 §3).
//
// S1 structural (zero LLM) → S3 extract → S4 prepare + conflict → S6 batched two-phase load, then
// write the lexicon. Runs are independent and idempotent (every write is a MERGE).

import type { EdgeBatch, GraphClient, NodeBatch } from '@errata/graph';
import type { History } from './reader.js';
import type { Extractor } from './extract.js';
import { buildStructural } from './structural.js';
import { buildClaims, prepareClaims, resolveConflicts } from './build.js';
import { buildLexicon, writeLexicon } from './lexicon.js';

export interface AssembleResult {
  nodes: NodeBatch[];
  edges: EdgeBatch[];
  entities: { norm: string; id: number; key: string; etype: string }[];
  counts: { sessions: number; turns: number; salient: number; claims: number; entities: number; supersedes: number; contradicts: number; supports: number };
}

/** Pure assembly of all node/edge batches for a history (no I/O) — the testable core of ingest. */
export function assemble(history: History, extracted: Awaited<ReturnType<Extractor['extract']>>, opts: { model: string; runId: string; ingestTime: number }): AssembleResult {
  const structural = buildStructural(history, opts.runId, opts.ingestTime);
  const prepared = prepareClaims(history, extracted, opts.ingestTime);
  const revision = resolveConflicts(prepared);
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

export interface IngestOptions {
  extractor: Extractor;
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
  const a = assemble(history, extracted, { model: opts.extractor.model, runId, ingestTime });
  const { nodeBatches, edgeBatches } = await client.loadTwoPhase(a.nodes, a.edges);
  const lex = buildLexicon(history.historyId, a.entities);
  const lexiconPath = writeLexicon(opts.lexiconDir ?? 'var/lexicon', lex);
  return { ...a, historyId: history.historyId, runId, nodeBatches, edgeBatches, bookmark: client.bookmark, lexiconPath };
}
