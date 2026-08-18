// packages/mcp/src/schemas.ts — tool input schemas. Bounds mirror apps/api's own validation
// (apps/api/src/correction.ts CorrectionBody) so a bad call is rejected before it leaves the
// process, not after a round trip.

import { z } from 'zod';

const subject = z.string().min(1).max(200).describe('The entity the belief is about, e.g. "the user" or "Wells Fargo".');
const attribute = z.string().min(1).max(200).describe('The attribute name, e.g. "mortgage_preapproval_amount".');
const value = z.string().min(1).max(500).describe('The new value to record.');
const historyId = z.string().min(1).optional().describe("The history (memory corpus) id. Omit to use the server's configured default.");

export const AskInput = {
  question: z.string().min(1).describe('The natural-language question to ask the memory.'),
  history_id: historyId,
  question_date: z.string().optional().describe('ISO date the question is being asked as-of (for relative-time phrasing). Defaults to today.'),
};

export const RememberInput = {
  subject,
  attribute,
  value,
  history_id: historyId,
};

export const CorrectInput = {
  subject,
  attribute,
  value,
  history_id: historyId,
  supersedes_claim_id: z.number().int().nonnegative().optional().describe('The specific claim id to supersede. Omit to supersede the current head belief.'),
};

export const HistoryInput = {
  subject,
  attribute,
  history_id: historyId,
  from: z.string().optional().describe('Start of the as-of window: epoch seconds or an ISO date. Defaults to the beginning of the chain.'),
  to: z.string().optional().describe('End of the as-of window: epoch seconds or an ISO date. Defaults to now.'),
};
