import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { ANSWER_MODEL, ANSWER_PROMPT } from '@errata/core';
import { app } from './app.js';
import { normText } from './query.js';

describe('api — no-DB routes', () => {
  it('/health is ok', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('/api/meta exposes the disclosed answer model, Errata mechanism, and the prompt sha256', async () => {
    const res = await app.request('/api/meta');
    const body = (await res.json()) as { answer_model: string; answer_mechanism: string; answer_prompt_sha256: string; schema_version: string };
    expect(body.answer_model).toBeTruthy(); // the disclosed baseline answer model (from config/models.json)
    expect(body.answer_mechanism).toBe(ANSWER_MODEL); // Errata's own arm is a graph fold
    expect(body.answer_prompt_sha256).toBe(createHash('sha256').update(ANSWER_PROMPT).digest('hex'));
    expect(body.schema_version).toBe('1.1');
  });

  it('/api/belief requires subject and attribute', async () => {
    const res = await app.request('/api/belief?subject=the%20user');
    expect(res.status).toBe(400);
  });

  it('normText matches the ingest normalizer contract (delimiter-free, collapsed)', () => {
    expect(normText('  The User! ')).toBe('the user');
    expect(normText('Wells Fargo')).toBe('wells fargo');
  });
});
