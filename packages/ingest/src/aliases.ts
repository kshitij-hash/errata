// packages/ingest/src/aliases.ts — WRITE-SIDE semantic bridging (anchor resolution step 0, G5).
//
// The ask path is a lexicon lookup: a question token that is not literally an entity name or an
// attribute word resolves to nothing. That is the front door the failure taxonomy found shut — the
// extractor names an attribute `direct_report_count` and the user asks "how many engineers do I
// lead", and the two share no token.
//
// The bridge is built ONCE, HERE, at ingest: the same extractor model that produced the claims is
// asked for the surface forms and question phrasings of each entity and each attribute. The result
// is baked into the lexicon artifact and is a plain string→string map thereafter. The answer path
// therefore stays what hard rule 2 requires: deterministic, no model, no vectors. Every call
// goes through @errata/llm, so it is budget-guarded, ledgered, and $0 on replay.

import { z } from 'zod';
import type { Completer } from './llm.js';

/** Bounded so one pathological history cannot turn a $0.002 call into a $0.20 one. */
export const MAX_ENTITIES = 60;
export const MAX_ATTRIBUTES = 120;
export const MAX_ALIASES_PER_TERM = 6;

export const AliasSchema = z.object({
  entities: z.array(z.object({ name: z.string(), aliases: z.array(z.string()) })),
  attributes: z.array(z.object({ name: z.string(), aliases: z.array(z.string()) })),
});

export interface AliasSets {
  /** normalized entity name → alias surface forms */
  entities: Record<string, string[]>;
  /** canonical attribute name → question phrasings */
  attributes: Record<string, string[]>;
}

export const EMPTY_ALIASES: AliasSets = { entities: {}, attributes: {} };

const SYSTEM = [
  'You expand a memory index so a user question can be matched to stored facts by plain string',
  'lookup. For each ENTITY give other names the same thing is called (nicknames, short forms,',
  'the common noun for a brand, "the user" for a person speaking in first person).',
  'For each ATTRIBUTE (a snake_case fact name) give the words and short phrases a person would',
  'use when ASKING about it — verbs and question wordings, not just synonyms:',
  'employer -> work at, work for, company, job, employed by; direct_report_count -> team size,',
  'how many people, engineers, reports, manage; total_spent -> cost, price, paid, spend, how much.',
  `At most ${MAX_ALIASES_PER_TERM} aliases each, lowercase, no duplicates, no invented facts —`,
  'aliases are vocabulary, never new values. Return the strict JSON schema.',
].join(' ');

/** Deterministic post-processing: lowercase, dedupe, drop echoes of the term itself, cap. */
export function normalizeAliasList(term: string, raw: readonly string[]): string[] {
  const self = term.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const out: string[] = [];
  const seen = new Set<string>([self]);
  for (const a of raw) {
    const v = a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!v || v.length < 2 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_ALIASES_PER_TERM) break;
  }
  return out;
}

export interface AliasGenerator {
  generate(historyId: string, entities: readonly string[], attributes: readonly string[]): Promise<AliasSets>;
}

/** The single LLM call per history. Failure is never fatal: an empty alias set degrades the ask
 *  path to exactly the behaviour it had before this file existed. */
export class LlmAliasGenerator implements AliasGenerator {
  private readonly completer: Completer;
  private readonly runId: string;

  constructor(completer: Completer, runId = 'run') {
    this.completer = completer;
    this.runId = runId;
  }

  async generate(historyId: string, entities: readonly string[], attributes: readonly string[]): Promise<AliasSets> {
    const ents = [...new Set(entities)].slice(0, MAX_ENTITIES);
    const attrs = [...new Set(attributes)].slice(0, MAX_ATTRIBUTES);
    if (ents.length === 0 && attrs.length === 0) return EMPTY_ALIASES;
    try {
      const res = await this.completer.complete({
        role: 'extractor',
        history_id: historyId,
        unit_id: `aliases:${historyId}`,
        run_id: this.runId,
        schema: AliasSchema,
        schemaName: 'aliases',
        reasoningEnabled: false,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: JSON.stringify({ entities: ents, attributes: attrs }),
          },
        ],
      });
      const parsed = AliasSchema.safeParse(res.json);
      if (!parsed.success) return EMPTY_ALIASES;
      const out: AliasSets = { entities: {}, attributes: {} };
      for (const e of parsed.data.entities) {
        const list = normalizeAliasList(e.name, e.aliases);
        if (list.length) out.entities[e.name] = list;
      }
      for (const a of parsed.data.attributes) {
        const list = normalizeAliasList(a.name, a.aliases);
        if (list.length) out.attributes[a.name] = list;
      }
      return out;
    } catch {
      return EMPTY_ALIASES; // an alias miss costs recall, never an ingest
    }
  }
}
