// Live API test against the ingested demo history (run `node packages/ingest/dist/cli.js 852ce960`
// against a running stack first). Gated on ERRATA_IT=1.
import { describe, it, expect, beforeAll } from 'vitest';
import type { Hono } from 'hono';

const RUN = process.env.ERRATA_IT === '1';
const HID = '852ce960';

describe.skipIf(!RUN)('api — live demo beats on 852ce960', () => {
  let app: Hono;
  beforeAll(async () => {
    process.env.ERRATA_DEMO_HISTORY = HID;
    process.env.ERRATA_LEXICON_DIR = 'var/lexicon';
    app = (await import('./app.js')).app;
  });

  it('belief: current pre-approval is $400,000, superseding $350,000, both cited', async () => {
    const res = await app.request(`/api/belief?subject=the%20user&attribute=mortgage_preapproval_amount&history_id=${HID}`);
    const b = (await res.json()) as { belief: { value: string; citation: { session_id: string } }; superseded: { value: string }[]; chain_len: number };
    expect(b.belief.value).toBe('$400,000');
    expect(b.belief.citation.session_id).toBe('answer_3a6f1e82_2');
    expect(b.superseded.map((s) => s.value)).toContain('$350,000');
    expect(b.chain_len).toBe(2);
  });

  it('ask: answers the amount question with a citation', async () => {
    const res = await app.request('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'What was the amount I was pre-approved for when I got my mortgage from Wells Fargo?', history_id: HID }),
    });
    const a = (await res.json()) as { answer?: string; abstained?: boolean; citations: { session_id: string; turn_index: number; span: string }[]; cypher: unknown[]; trace_id: string };
    expect(a.answer).toBe('$400,000');
    expect(a.abstained).toBeUndefined();
    expect(a.citations[0]!.session_id).toBe('answer_3a6f1e82_2');
    expect(typeof a.citations[0]!.turn_index).toBe('number'); // integer, never a string-split of turn_id
    expect(Array.isArray(a.cypher)).toBe(true); // the executed Cypher is surfaced
    expect(typeof a.trace_id).toBe('string');
  });

  it('abstains on a question the history never answers, with nearest misses', async () => {
    const res = await app.request('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'What is my favorite color?', history_id: HID }),
    });
    const a = (await res.json()) as { abstained?: boolean; nearest_miss: unknown[] };
    expect(a.abstained).toBe(true);
    expect(Array.isArray(a.nearest_miss)).toBe(true);
  });
});
