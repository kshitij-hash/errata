// The pinned demo history's front-of-house configuration (seed chips from a config file").
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
    // The gold chip has to ABSTAIN on the live history, and that is a measured property, not an
    // editorial one. "How much did I pay for the new home?" used to sit here and stopped being
    // true: the history does hold a purchase price, so the ask answers $325,000 at E = 0.379,
    // above τ — a chip labelled "→ abstains" over an answered question is the worst possible lie
    // for this demo to tell. This one is verified against the live demo history: E = 0.293, below
    // τ, and it still lands one nearest miss with a citation, so the refusal card has something to
    // set aside rather than rendering empty.
    id: 'dog',
    label: "What is my dog's name? → abstains",
    question: "What is my dog's name?",
    abstains: true,
  },
];

/** The chains the Timeline can open; the first is the knowledge-update beat. */
export const TIMELINE_ATTRIBUTES: { attribute: string; label: string }[] = [
  { attribute: 'mortgage_preapproval_amount', label: 'mortgage pre-approval amount' },
  { attribute: 'mortgage_lender', label: 'mortgage lender' },
  { attribute: 'job_title', label: 'job title' },
  { attribute: 'millennium_park_familiarity', label: 'millennium park familiarity' },
  { attribute: 'home_purchase_status', label: 'home purchase status' },
  { attribute: 'job_offer', label: 'job offer' },
];

/** Attributes the Constellation view draws around the subject (subject-scoped, not the whole graph). */
export const CONSTELLATION_ATTRIBUTES: string[] = [
  'mortgage_preapproval_amount',
  'mortgage_lender',
  'job_title',
  'job_offer',
  'home_purchase_status',
  'millennium_park_familiarity',
  'daily_commute_duration_minutes',
];

export const TAGLINE =
  'Memory that keeps its corrections — every answer cited, every revision kept, refusal when the history never says.';
