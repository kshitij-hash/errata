// packages/ingest/src/lexicon.ts — the term dictionary for the ask path (spec 31 §4.7 step 0).
//
// A plain normToken → [entity_vid] map (plus alias forms), and a stemmed term → [attribute] map.
// This is NOT a vector store: it maps mentions to ids and contributes nothing to ranking, evidence,
// ordering, revision, or citation — all of which come from the graph. CONTEXT standing rule 2 stays
// intact. Everything semantic in it was computed ONCE at ingest (see aliases.ts) and is a frozen
// string→string lookup by the time a question arrives.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { lexTokens, stem } from '@errata/core';
import type { AliasSets } from './aliases.js';
import { EMPTY_ALIASES } from './aliases.js';

export interface Lexicon {
  historyId: string;
  self: number[]; // SELF entity ids (first-person questions anchor here)
  terms: Record<string, number[]>; // normToken/normName → entity ids
  /** stemmed question term → canonical attribute names it can be asking about (write-side aliases) */
  attrTerms?: Record<string, string[]>;
  /** canonical attribute name → its alias phrases, for claim-side token expansion at rank time */
  attrAliases?: Record<string, string[]>;
}

const FIRST_PERSON = ['i', 'me', 'my', 'myself', 'user'];

export function buildLexicon(
  historyId: string,
  entities: { norm: string; id: number; etype?: string }[],
  attributes: readonly string[] = [],
  aliases: AliasSets = EMPTY_ALIASES,
): Lexicon {
  const terms: Record<string, number[]> = {};
  const self: number[] = [];
  const add = (token: string, id: number): void => {
    if (!token) return;
    const list = (terms[token] ??= []);
    if (!list.includes(id)) list.push(id);
  };
  const addPhrase = (phrase: string, id: number): void => {
    add(phrase, id);
    for (const tok of phrase.split(' ')) if (tok.length > 1) add(tok, id);
    // the stemmed forms too, so a question's "markets" reaches an entity called "market"
    const stems = lexTokens(phrase);
    if (stems.length) add(stems.join(' '), id);
    for (const s of stems) if (s.length > 1) add(s, id);
  };
  for (const e of entities) {
    addPhrase(e.norm, e.id);
    for (const alias of aliases.entities[e.norm] ?? []) addPhrase(alias, e.id);
    if (e.etype === 'SELF' || e.norm === 'the user') {
      if (!self.includes(e.id)) self.push(e.id);
      for (const fp of FIRST_PERSON) add(fp, e.id);
    }
  }

  // attribute side: a stemmed question term → the attributes it could name.
  const attrTerms: Record<string, string[]> = {};
  const attrAliases: Record<string, string[]> = {};
  const link = (term: string, attribute: string): void => {
    if (!term) return;
    const list = (attrTerms[term] ??= []);
    if (!list.includes(attribute)) list.push(attribute);
  };
  for (const attribute of new Set(attributes)) {
    const phrases = [attribute.replace(/_/g, ' '), ...(aliases.attributes[attribute] ?? [])];
    const own = aliases.attributes[attribute] ?? [];
    if (own.length) attrAliases[attribute] = own;
    for (const phrase of phrases) {
      const toks = lexTokens(phrase);
      if (toks.length > 1) link(toks.join(' '), attribute);
      for (const t of toks) link(t, attribute);
    }
  }
  return { historyId, self, terms, attrTerms, attrAliases };
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
  const attrTerms: Record<string, string[]> = {};
  for (const src of [a.attrTerms ?? {}, b.attrTerms ?? {}]) {
    for (const [token, attrs] of Object.entries(src)) {
      const list = (attrTerms[token] ??= []);
      for (const at of attrs) if (!list.includes(at)) list.push(at);
    }
  }
  const attrAliases: Record<string, string[]> = { ...(a.attrAliases ?? {}) };
  for (const [attribute, list] of Object.entries(b.attrAliases ?? {})) {
    const prev = attrAliases[attribute] ?? [];
    attrAliases[attribute] = [...prev, ...list.filter((x) => !prev.includes(x))];
  }
  const self: number[] = [];
  for (const id of [...a.self, ...b.self]) if (!self.includes(id)) self.push(id);
  return { historyId: a.historyId, self, terms, attrTerms, attrAliases };
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

/** stem() re-exported so the ask path and the write path cannot drift on the same token. */
export { stem };
