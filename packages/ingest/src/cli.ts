#!/usr/bin/env node
// @errata/ingest CLI — ingest LongMemEval histories into HydraDB.
//   errata-ingest <history_id>              ingest one history (RuleExtractor by default)
//   errata-ingest --all --structural-only   ingest ALL 500 histories, structural pass only (zero LLM)
// flags: --file <path> --ids-file <json-array> --extractor rule|replay|llm --replay-dir <d> --lexicon-dir <d> --judge
//        --mem-guard-gb <n> (default 4.5; 0 disables) drain-and-restart the local HydraDB container
//        at a HISTORY BOUNDARY when its RSS crosses n GiB, instead of letting the kernel SIGKILL it
//        --aliases  one extractor-model call per history bakes entity/attribute aliases into the lexicon
//        --history-suffix <s> ingest into a FRESH history-id namespace (`<question_id><s>`). Every
//        vertex key is history-scoped, so this is a disjoint subgraph: a clean re-ingest that
//        leaves existing (funded) data for the same question_id completely intact.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { GraphClient } from '@errata/graph';
import { OpenRouterClient, defaultLedgerDir, rollup } from '@errata/llm';
import { parseHistory, turnCount } from './reader.js';
import type { RawRecord } from './reader.js';
import { NullExtractor, ReplayExtractor, RuleExtractor } from './extract.js';
import type { Extractor } from './extract.js';
import { LlmExtractor, makeJudge } from './llm.js';
import type { ConflictJudge } from './llm.js';
import { LlmAliasGenerator } from './aliases.js';
import type { AliasGenerator } from './aliases.js';
import { ingestHistory } from './pipeline.js';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

// ---- memory guard -------------------------------------------------------------------------------
// The HydraDB node's RSS grows without bound under sustained bulk writes (no documented RAM knob;
// write buffers are already 64 MiB — the growth is internal engine state). Unguarded, the Docker VM
// kernel SIGKILLs it mid-write, which is what corrupts the cell-ownership lease ("cell cell-0 is
// not owned by this node"). The fix is flow control on OUR side: watch the node's RSS and, at a
// history boundary (never mid-batch), gracefully drain-and-restart it BEFORE the kernel acts. A
// graceful stop releases the lease cleanly, so the failure mode disappears rather than being retried.

const HYDRA_CONTAINER = process.env.ERRATA_HYDRA_CONTAINER ?? 'errata-hydradb-1';

/** Node RSS in GiB via `docker stats` (the only reliable gauge on a macOS VM); -1 = unknown. */
function nodeMemGiB(): number {
  try {
    const out = execFileSync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', HYDRA_CONTAINER], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    const m = /^([\d.]+)(KiB|MiB|GiB)/.exec(out.trim());
    if (!m) return -1;
    const v = Number(m[1]);
    return m[2] === 'GiB' ? v : m[2] === 'MiB' ? v / 1024 : v / (1024 * 1024);
  } catch {
    return -1;
  }
}

/** Gracefully restart the node and wait for healthy. Only ever called between histories. */
async function drainRestart(client: GraphClient): Promise<void> {
  execFileSync('docker', ['compose', 'restart', 'hydradb'], { timeout: 120_000 });
  for (let i = 0; i < 40; i++) {
    try {
      const s = execFileSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', HYDRA_CONTAINER], {
        encoding: 'utf8',
        timeout: 10_000,
      }).trim();
      if (s === 'healthy') break;
    } catch {
      /* container mid-restart */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  await client.verify(); // recreates the driver against the fresh node
}

async function main(): Promise<void> {
  const file = arg('file', 'data-raw/longmemeval_s_cleaned.json');
  const structuralOnly = has('structural-only');
  const all = has('all');
  const extractorName = arg('extractor', 'rule');
  const lexiconDir = arg('lexicon-dir', 'var/lexicon');
  const historySuffix = arg('history-suffix');
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

  // build the extractor (+ judge, + alias generator)
  const useAliases = has('aliases');
  let extractor: Extractor;
  let judge: ConflictJudge | undefined;
  let aliases: AliasGenerator | undefined;
  if (structuralOnly) {
    extractor = new NullExtractor();
  } else if (extractorName === 'llm' || useJudge || useAliases) {
    const cap = process.env.ERRATA_BUDGET_CAP ? Number(process.env.ERRATA_BUDGET_CAP) : 50;
    const or = new OpenRouterClient({ initialSpent: rollup(defaultLedgerDir(), cap).spent_usd });
    extractor = extractorName === 'llm' ? new LlmExtractor(or, 'llm-extractor') : new RuleExtractor();
    if (useJudge) judge = makeJudge(or, 'ingest');
    if (useAliases) aliases = new LlmAliasGenerator(or);
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
    const memGuardGb = Number(arg('mem-guard-gb', '4.5'));
    for (const rec of records) {
      const parsed = parseHistory(rec);
      // a fresh namespace is just a fresh history_id: every key is `h:<history_id>|…`, so the
      // re-ingest shares no vertex with the original and destroys nothing.
      const history = historySuffix ? { ...parsed, historyId: `${parsed.historyId}${historySuffix}` } : parsed;
      if (memGuardGb > 0) {
        const gib = nodeMemGiB();
        if (gib > memGuardGb) {
          console.log(`  [mem-guard] node at ${gib.toFixed(2)} GiB > ${memGuardGb} GiB — graceful drain-and-restart before next history`);
          await drainRestart(client);
        }
      }
      // one history failing must not kill a multi-hour run: reconnect, retry once, else record
      // and continue (ingest is MERGE-idempotent, so the failed id can simply be re-run later).
      let s: Awaited<ReturnType<typeof ingestHistory>>;
      try {
        s = await ingestHistory(client, history, { extractor, judge, aliases, lexiconDir });
      } catch (e1) {
        console.error(`  ${history.historyId}: FAILED (${(e1 as Error).message.slice(0, 120)}) — reconnecting for one retry`);
        try {
          await client.verify();
          s = await ingestHistory(client, history, { extractor, judge, aliases, lexiconDir });
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
