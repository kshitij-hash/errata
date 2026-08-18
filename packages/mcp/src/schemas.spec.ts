// packages/mcp/src/schemas.spec.ts — input validation bounds. Pure zod, no I/O.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AskInput, CorrectInput, HistoryInput, RememberInput } from './schemas.js';

describe('AskInput', () => {
  const schema = z.object(AskInput);
  it('accepts a bare question', () => {
    expect(schema.safeParse({ question: 'What was I pre-approved for?' }).success).toBe(true);
  });
  it('rejects an empty question', () => {
    expect(schema.safeParse({ question: '' }).success).toBe(false);
  });
});

describe('RememberInput / CorrectInput bounds mirror apps/api CorrectionBody', () => {
  const remember = z.object(RememberInput);
  const correct = z.object(CorrectInput);

  it('accepts a well-formed observation', () => {
    expect(remember.safeParse({ subject: 'the user', attribute: 'mortgage_preapproval_amount', value: '$400,000' }).success).toBe(true);
  });

  it('rejects an empty subject, attribute, or value', () => {
    expect(remember.safeParse({ subject: '', attribute: 'a', value: 'v' }).success).toBe(false);
    expect(remember.safeParse({ subject: 's', attribute: '', value: 'v' }).success).toBe(false);
    expect(remember.safeParse({ subject: 's', attribute: 'a', value: '' }).success).toBe(false);
  });

  it('rejects a value over 500 chars, matching apps/api/src/correction.ts CorrectionBody', () => {
    expect(remember.safeParse({ subject: 's', attribute: 'a', value: 'x'.repeat(501) }).success).toBe(false);
    expect(remember.safeParse({ subject: 's', attribute: 'a', value: 'x'.repeat(500) }).success).toBe(true);
  });

  it('memory_correct additionally accepts an optional non-negative supersedes_claim_id', () => {
    expect(correct.safeParse({ subject: 's', attribute: 'a', value: 'v', supersedes_claim_id: 42 }).success).toBe(true);
    expect(correct.safeParse({ subject: 's', attribute: 'a', value: 'v', supersedes_claim_id: -1 }).success).toBe(false);
    expect(correct.safeParse({ subject: 's', attribute: 'a', value: 'v', supersedes_claim_id: 1.5 }).success).toBe(false);
  });
});

describe('HistoryInput', () => {
  const schema = z.object(HistoryInput);
  it('accepts just subject + attribute', () => {
    expect(schema.safeParse({ subject: 'the user', attribute: 'mortgage_preapproval_amount' }).success).toBe(true);
  });
  it('accepts an as-of window as epoch-second strings or ISO dates', () => {
    expect(schema.safeParse({ subject: 's', attribute: 'a', from: '0', to: '1700000000' }).success).toBe(true);
    expect(schema.safeParse({ subject: 's', attribute: 'a', from: '2023-01-01', to: '2024-01-01' }).success).toBe(true);
  });
});
