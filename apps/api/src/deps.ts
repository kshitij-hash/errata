// apps/api/src/deps.ts — process singletons: config, the Bolt client, the lexicon cache.
import { existsSync, readFileSync } from 'node:fs';
import { GraphClient } from '@errata/graph';

export interface Config {
  boltUrl: string;
  token: string;
  database: string;
  demoHistory: string;
  lexiconDir: string;
  tau: number;
}

function readTokenFrom(pathEnv: string | undefined): string {
  if (process.env.HYDRA_TOKEN) return process.env.HYDRA_TOKEN;
  const path = pathEnv ?? '.data/hydra/auth-token';
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
}

export function loadConfig(): Config {
  return {
    boltUrl: process.env.HYDRA_BOLT_URL ?? 'bolt://127.0.0.1:7687',
    token: readTokenFrom(process.env.HYDRA_TOKEN_FILE),
    database: process.env.GRAPH_ID ?? 'default',
    demoHistory: process.env.ERRATA_DEMO_HISTORY ?? '',
    lexiconDir: process.env.ERRATA_LEXICON_DIR ?? 'var/lexicon',
    tau: process.env.ERRATA_TAU ? Number(process.env.ERRATA_TAU) : 0.35,
  };
}

export const config = loadConfig();

let _client: GraphClient | undefined;
export function db(): GraphClient {
  if (!_client) {
    _client = new GraphClient({ url: config.boltUrl, token: config.token, database: config.database });
    // read-your-writes against the last ingest bookmark if one was recorded
    if (existsSync('var/bookmark.txt')) {
      const bm = readFileSync('var/bookmark.txt', 'utf8').trim();
      if (bm) _client.setBookmarks(bm.split('\n').filter(Boolean));
    }
  }
  return _client;
}

// --- lexicon cache (spec 31 §4.7 step 0) ---
export interface Lexicon {
  historyId: string;
  self: number[];
  terms: Record<string, number[]>;
}
const _lex = new Map<string, Lexicon | null>();

export function lexicon(historyId: string): Lexicon | null {
  if (_lex.has(historyId)) return _lex.get(historyId)!;
  const path = `${config.lexiconDir}/${historyId}.json`;
  const lex = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Lexicon) : null;
  _lex.set(historyId, lex);
  return lex;
}

// --- the compare-beat fixture (bge-small cosines measured offline by eval/embed_beat.py, R4/B3) ---
//
// Two measurements live in the file, each with its provenance. `candidates` is the one this API
// serves: what a vector store hands back FOR THE QUERY, highest retrieval cosine first — on the
// demo history that is the SUPERSEDED claim. `pair` (read by the Compare page, not by this API) is
// the cosine between the two claims' own evidence spans. The filename is historical: the number in
// it is whatever was measured, never a target.
export interface BeatFixture {
  query: string;
  candidates: { text: string; cosine: number; superseded?: boolean; citation?: unknown }[];
  embedder: string;
  measured_at?: string;
  history_id?: string;
  pair?: { cosine: number; attribute: string; basis: string };
}
let _beat: BeatFixture | null | undefined;
export function beatFixture(): BeatFixture | null {
  if (_beat === undefined) {
    const path = process.env.ERRATA_BEAT_FIXTURE ?? 'apps/web/fixtures/beat-0.94.json';
    _beat = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as BeatFixture) : null;
  }
  return _beat;
}
