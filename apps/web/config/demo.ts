// The pinned demo history's front-of-house configuration (36 §4.2: "seed chips from a config file").
// Everything here is either derived from the ingested corpus or a disclosed price constant — no
// answer text is hard-coded; every answer on screen comes from /api/ask at request time.
import sessions from './demo-sessions.json';

export interface Chip {
  id: string;
  label: string;
  question: string;
  /** the gold chip: the history genuinely never says, so the answer path abstains */
  abstains?: boolean;
}

/** The subject every claim in this history hangs off (the extractor's canonical self-entity). */
export const DEMO_SUBJECT = 'the user';

export const DEMO_HISTORY_ID: string = sessions.history_id;

/** One tick per session of the demo history, in corpus order (add-on №2, the session spine). */
export const DEMO_SESSIONS: {
  ordinal: number;
  session_id: string;
  date: string;
}[] = sessions.sessions;

/** Whole-history size — the denominator of the "full context would have cost" estimate. */
export const HISTORY_TOKEN_COUNT: number = sessions.approx_tokens;
export const HISTORY_TURN_COUNT: number = sessions.turn_count;

/**
 * Disclosed answer-model input price, USD per million tokens, copied from eval/prices.toml
 * (qwen/qwen3.7-flash pinned at its observed long-context tier). Used only for the client-side
 * "≈ estimate" half of the economics line — never for anything the ledger reports.
 */
export const ANSWER_MODEL_IN_PER_MTOK = 0.1;

export const FULL_CONTEXT_USD = (HISTORY_TOKEN_COUNT * ANSWER_MODEL_IN_PER_MTOK) / 1_000_000;

export const CHIPS: Chip[] = [
  {
    id: 'preapproval',
    label: 'What was I pre-approved for?',
    question: 'What was the amount I was pre-approved for when I got my mortgage from Wells Fargo?',
  },
  {
    id: 'lender',
    label: 'Who is my mortgage lender?',
    question: 'Who is my mortgage lender?',
  },
  {
    id: 'job',
    label: 'What is my job title?',
    question: 'What is my job title?',
  },
  {
    id: 'price',
    label: 'How much did I pay for the new home? → abstains',
    question: 'How much did I pay for the new home?',
    abstains: true,
  },
];

/** The attribute chain the Timeline opens on (the knowledge-update beat). */
export const TIMELINE_ATTRIBUTES: { attribute: string; label: string }[] = [
  {
    attribute: 'mortgage_preapproval_amount',
    label: 'mortgage pre-approval amount',
  },
  { attribute: 'mortgage_lender', label: 'mortgage lender' },
  {
    attribute: 'millennium_park_familiarity',
    label: 'millennium park familiarity',
  },
  { attribute: 'job_offer', label: 'job offer' },
  { attribute: 'certification_interest', label: 'certification interest' },
];

export const TAGLINE =
  'Memory that keeps its corrections — every answer cited, every revision kept, refusal when the history never says.';
