// packages/ingest/src/lexicon.ts — the term dictionary for the ask path (spec 31 §4.7 step 0).
//
// A plain normToken → [entity_vid] map (plus alias forms). This is NOT a vector store: it maps
// mentions to ids and contributes nothing to ranking, evidence, ordering, revision, or citation —
// all of which come from the graph. CONTEXT standing rule 2 stays intact.

import { mkdirSync, writeFileSync } from 'node:fs';

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

export function writeLexicon(dir: string, lex: Lexicon): string {
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${lex.historyId}.json`;
  writeFileSync(path, JSON.stringify(lex));
  return path;
}
