// packages/core/src/prompt.ts — the ONE answer prompt (integration seam).
//
// Errata RETRIEVES deterministically — a graph fold, no vector store (hard rule 2) — and then
// composes the prose with ONE LLM call over exactly the folded material (v2 synthesis,
// `errata-graph-synthesis@2`). Only a keyless process (vitest, creditless dev) falls back to
// serving the fold verbatim as `errata-graph-fold@1`; /api/meta.answer_mechanism reports which
// of the two is live. All three arms — Errata and both baselines — answer under THIS template,
// which is the point of holding it here, and its sha256 (computed at the API boundary) is
// exposed via /api/meta so eval vendors it by hash, not by copy-paste. Editing this string
// changes that hash.

/** The keyless fallback mechanism id. The funded path reports `errata-graph-synthesis@2`. */
export const ANSWER_MODEL = 'errata-graph-fold@1';

// Byte-identical to eval/errata_eval/prompts.py::ANSWER_PROMPT (integration seam). The eval's parity gate
// asserts sha256(this) == /api/meta.answer_prompt_sha256 before any spend. Editing either side
// without the other breaks that gate — that is the point.
export const ANSWER_PROMPT = [
  "You are answering a question about a user's own chat history with an assistant.",
  '',
  "Today's date is {question_date}.",
  '',
  'Use ONLY the material provided below. Do not use outside knowledge. Do not guess.',
  '',
  'If the material does not contain the information needed to answer, your entire reply must be',
  'exactly:',
  'INSUFFICIENT_INFORMATION: <one sentence naming the closest related thing the history does mention>',
  '',
  'Otherwise reply with the answer only — no preamble, no restatement of the question, no citations,',
  'no explanation. Be specific: give names, dates, and numbers exactly as the material states them.',
  'If the material states a fact and later states a different value for the same fact, answer with',
  'the LATER value.',
  '',
  '--- MATERIAL ---',
  '{context}',
  '--- END MATERIAL ---',
  '',
  'Question: {question}',
  'Answer:',
].join('\n');

export const SCHEMA_VERSION = '1.1';
