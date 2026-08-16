#!/usr/bin/env node
// @errata/ingest CLI — ingest LongMemEval histories into HydraDB.
//   errata-ingest <history_id>              ingest one history (RuleExtractor by default)
//   errata-ingest --all --structural-only   ingest ALL 500 histories, structural pass only (zero LLM)
// flags: --file <path> --ids-file <json-array> --extractor rule|replay|llm --replay-dir <d> --lexicon-dir <d> --judge
import { readFileSync } from 'node:fs';
import { GraphClient } from '@errata/graph';
import { OpenRouterClient, defaultLedgerDir, rollup } from '@errata/llm';
import { parseHistory, turnCount } from './reader.js';
import type { RawRecord } from './reader.js';
import { NullExtractor, ReplayExtractor, RuleExtractor } from './extract.js';
import type { Extractor } from './extract.js';
import { LlmExtractor, makeJudge } from './llm.js';
import type { ConflictJudge } from './llm.js';
import { ingestHistory } from './pipeline.js';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const file = arg('file', 'data-raw/longmemeval_s_cleaned.json');
  const structuralOnly = has('structural-only');
  const all = has('all');
  const extractorName = arg('extractor', 'rule');
  const lexiconDir = arg('lexicon-dir', 'var/lexicon');
  const useJudge = has('judge');
  const url = process.env.HYDRA_BOLT_URL ?? 'bolt://127.0.0.1:7687';
  const token = process.env.HYDRA_TOKEN ?? readFileSync('.data/hydra/auth-token', 'utf8').trim();

  // resolve the records to ingest (load the 277 MB corpus exactly once)
  const corpus = JSON.parse(readFileSync(file, 'utf8')) as RawRecord[];
  const idsFile = arg('ids-file');
  let records: RawRecord[];
  if (all) {
    records = corpus;
  } else if (idsFile !== '') {
    const ids = new Set(JSON.parse(readFileSync(idsFile, 'utf8')) as string[]);
    records = corpus.filter((r) => ids.has(r.question_id));
    if (records.length !== ids.size) {
      console.error(`ids-file: ${ids.size} ids requested, ${records.length} found in corpus`);
      process.exit(1);
    }
  } else {
    const id = process.argv[2];
    if (!id || id.startsWith('--')) {
      console.error('usage: errata-ingest <history_id>|--all [--structural-only] [--extractor rule|replay|llm] [--judge]');
      process.exit(1);
    }
    const rec = corpus.find((r) => r.question_id === id);
    if (!rec) {
      console.error(`history_id ${id} not found in ${file}`);
      process.exit(1);
    }
    records = [rec];
  }

  // build the extractor (+ judge)
  let extractor: Extractor;
  let judge: ConflictJudge | undefined;
  if (structuralOnly) {
    extractor = new NullExtractor();
  } else if (extractorName === 'llm' || useJudge) {
    const cap = process.env.ERRATA_BUDGET_CAP ? Number(process.env.ERRATA_BUDGET_CAP) : 50;
    const or = new OpenRouterClient({ initialSpent: rollup(defaultLedgerDir(), cap).spent_usd });
    extractor = extractorName === 'llm' ? new LlmExtractor(or, 'llm-extractor') : new RuleExtractor();
    if (useJudge) judge = makeJudge(or, 'ingest');
  } else {
    extractor = extractorName === 'replay' ? new ReplayExtractor(arg('replay-dir', 'fixtures/replay')) : new RuleExtractor();
  }

  console.log(`ingesting ${records.length} histor${records.length === 1 ? 'y' : 'ies'} with ${extractor.model}${structuralOnly ? ' (structural only)' : ''}`);

  const client = new GraphClient({ url, token });
  try {
    await client.verify();
    const t0 = Date.now();
    let nodeBatches = 0;
    let edgeBatches = 0;
    let claims = 0;
    let turns = 0;
    let done = 0;
    const failed: string[] = [];
    for (const rec of records) {
      const history = parseHistory(rec);
      // one history failing must not kill a multi-hour run: reconnect, retry once, else record
      // and continue (ingest is MERGE-idempotent, so the failed id can simply be re-run later).
      let s: Awaited<ReturnType<typeof ingestHistory>>;
      try {
        s = await ingestHistory(client, history, { extractor, judge, lexiconDir });
      } catch (e1) {
        console.error(`  ${history.historyId}: FAILED (${(e1 as Error).message.slice(0, 120)}) — reconnecting for one retry`);
        try {
          await client.verify();
          s = await ingestHistory(client, history, { extractor, judge, lexiconDir });
        } catch (e2) {
          console.error(`  ${history.historyId}: FAILED TWICE (${(e2 as Error).message.slice(0, 120)}) — skipping`);
          failed.push(history.historyId);
          continue;
        }
      }
      nodeBatches += s.nodeBatches;
      edgeBatches += s.edgeBatches;
      claims += s.counts.claims;
      turns += s.counts.turns;
      done++;
      if (all) {
        if (done % 25 === 0 || done === records.length) {
          const el = (Date.now() - t0) / 1000;
          console.log(`  ${done}/${records.length} · ${(done / el).toFixed(1)} hist/s · ${turns} turns · ${claims} claims`);
        }
      } else {
        console.log(`  ${history.historyId}: ${history.sessions.length} sessions, ${turnCount(history)} turns → ${s.counts.claims} claims, ${s.counts.supersedes} supersessions`);
      }
    }
    const secs = (Date.now() - t0) / 1000;
    console.log(`OK — ${done} histories, ${nodeBatches}+${edgeBatches} node+edge batches, ${turns} turns, ${claims} claims in ${secs.toFixed(1)}s (${(done / secs).toFixed(1)} hist/s, ${(secs / done * 1000).toFixed(0)} ms/history)`);
    if (failed.length > 0) {
      console.error(`FAILED ${failed.length} histor${failed.length === 1 ? 'y' : 'ies'} (re-run these ids): ${failed.join(' ')}`);
      process.exit(2);
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
