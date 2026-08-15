#!/usr/bin/env node
// @errata/ingest CLI — ingest one LongMemEval history into HydraDB.
//   errata-ingest <history_id> [--file data-raw/longmemeval_s_cleaned.json]
//                              [--extractor rule|replay] [--replay-dir <dir>] [--lexicon-dir var/lexicon]
import { readFileSync } from 'node:fs';
import { GraphClient } from '@errata/graph';
import { OpenRouterClient } from '@errata/llm';
import { parseHistory, turnCount } from './reader.js';
import type { RawRecord } from './reader.js';
import { RuleExtractor, ReplayExtractor } from './extract.js';
import type { Extractor } from './extract.js';
import { LlmExtractor, makeJudge } from './llm.js';
import type { ConflictJudge } from './llm.js';
import { ingestHistory } from './pipeline.js';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

function loadRecord(path: string, historyId: string): RawRecord {
  const data = JSON.parse(readFileSync(path, 'utf8')) as RawRecord[];
  const rec = data.find((r) => r.question_id === historyId);
  if (!rec) throw new Error(`history_id ${historyId} not found in ${path}`);
  return rec;
}

async function main(): Promise<void> {
  const historyId = process.argv[2];
  if (!historyId || historyId.startsWith('--')) {
    console.error('usage: errata-ingest <history_id> [--file <path>] [--extractor rule|replay]');
    process.exit(1);
  }
  const file = arg('file', 'data-raw/longmemeval_s_cleaned.json');
  const extractorName = arg('extractor', 'rule');
  const lexiconDir = arg('lexicon-dir', 'var/lexicon');
  const url = process.env.HYDRA_BOLT_URL ?? 'bolt://127.0.0.1:7687';
  const token = process.env.HYDRA_TOKEN ?? readFileSync('.data/hydra/auth-token', 'utf8').trim();

  const history = parseHistory(loadRecord(file, historyId));
  console.log(`ingesting ${historyId}: ${history.sessions.length} sessions, ${turnCount(history)} turns`);

  const useJudge = process.argv.includes('--judge');
  let extractor: Extractor;
  let judge: ConflictJudge | undefined;
  if (extractorName === 'llm' || useJudge) {
    const or = new OpenRouterClient(); // reads OPENROUTER_API_KEY + config/models.json
    if (extractorName === 'llm') extractor = new LlmExtractor(or, 'llm-extractor', historyId);
    else extractor = new RuleExtractor();
    if (useJudge) judge = makeJudge(or, historyId, historyId);
  } else {
    extractor = extractorName === 'replay' ? new ReplayExtractor(arg('replay-dir', 'fixtures/replay')) : new RuleExtractor();
  }

  const client = new GraphClient({ url, token });
  try {
    await client.verify();
    const t0 = Date.now();
    const s = await ingestHistory(client, history, { extractor, judge, lexiconDir });
    const ms = Date.now() - t0;
    console.log(JSON.stringify({ ...s, bookmark: s.bookmark.length ? '<set>' : '<none>', ms }, null, 2));
    console.log(`OK — ${s.counts.claims} claims, ${s.counts.supersedes} supersessions, ${s.nodeBatches}+${s.edgeBatches} batches in ${ms}ms`);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
