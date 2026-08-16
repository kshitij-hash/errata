// packages/ingest/src/lexicon.ts — the term dictionary for the ask path (spec 31 §4.7 step 0).
//
// A plain normToken → [entity_vid] map (plus alias forms). This is NOT a vector store: it maps
// mentions to ids and contributes nothing to ranking, evidence, ordering, revision, or citation —
// all of which come from the graph. CONTEXT standing rule 2 stays intact.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export interface Lexicon {
  historyId: string;
  self: number[]; // SELF entity ids (first-person questions anchor here)
  terms: Record<string, number[]>; // normToken/normName → entity ids
}

const FIRST_PERSON = ['i', 'me', 'my', 'myself', 'user'];

export function buildLexicon(
  historyId: string,
  entities: { norm: string; id: number; etype?: string }[],
): Lexicon {
  const terms: Record<string, number[]> = {};
  const self: number[] = [];
  const add = (token: string, id: number): void => {
    if (!token) return;
    const list = (terms[token] ??= []);
    if (!list.includes(id)) list.push(id);
  };
  for (const e of entities) {
    add(e.norm, e.id); // full normalized name
    for (const tok of e.norm.split(' ')) if (tok.length > 1) add(tok, e.id); // and each token
    if (e.etype === 'SELF' || e.norm === 'the user') {
      if (!self.includes(e.id)) self.push(e.id);
      for (const fp of FIRST_PERSON) add(fp, e.id);
    }
  }
  return { historyId, self, terms };
}

/** Union of two lexicons for the same history (ids deduplicated, insertion order preserved). */
export function mergeLexicons(a: Lexicon, b: Lexicon): Lexicon {
  const terms: Record<string, number[]> = {};
  for (const src of [a.terms, b.terms]) {
    for (const [token, ids] of Object.entries(src)) {
      const list = (terms[token] ??= []);
      for (const id of ids) if (!list.includes(id)) list.push(id);
    }
  }
  const self: number[] = [];
  for (const id of [...a.self, ...b.self]) if (!self.includes(id)) self.push(id);
  return { historyId: a.historyId, self, terms };
}

/**
 * Write the lexicon, MERGING into any lexicon already on disk for this history.
 *
 * A history can legitimately be ingested by more than one extractor (the demo history is: the LLM
 * extractor for breadth, the rule extractor for the two mortgage facts it nails). The graph handles
 * that natively — every write is a MERGE by id — but this file used to be overwritten wholesale, so
 * whichever pass ran LAST silently narrowed the ask path's anchors to its own entities. Merging
 * makes the lexicon behave like the graph it describes: additive, never lossy.
 */
export function writeLexicon(dir: string, lex: Lexicon): string {
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${lex.historyId}.json`;
  let out = lex;
  if (existsSync(path)) {
    try {
      const prev = JSON.parse(readFileSync(path, 'utf8')) as Lexicon;
      if (prev.historyId === lex.historyId) out = mergeLexicons(prev, lex);
    } catch {
      // an unreadable lexicon is replaced, never allowed to fail the ingest
    }
  }
  writeFileSync(path, JSON.stringify(out));
  return path;
}
