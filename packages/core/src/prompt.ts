// packages/core/src/prompt.ts — the ONE answer prompt (integration seam #5).
//
// Errata's own answer path is a deterministic graph fold — it does NOT call an LLM to compose the
// answer (hard rule 2). This template exists so the eval harness's full-context / naive baselines
// answer under the SAME instructions, and its sha256 (computed at the API boundary) is exposed via
// /api/meta so eval vendors it by hash, not by copy-paste. Editing this string changes that hash.

export const ANSWER_MODEL = 'errata-graph-fold@1';

export const ANSWER_PROMPT = [
  'You are a careful memory system. Answer ONLY from the provided belief and its citation.',
  'If the belief is present, answer with its current value and cite (session_id, turn_id).',
  'If two beliefs are disputed, say so and cite both.',
  'If the answer is not in the history, abstain: say it is not in the history and give the nearest miss.',
  'Never invent a value. Never answer without a citation.',
].join('\n');

export const SCHEMA_VERSION = '1.1';
