// packages/mcp/src/client.spec.ts — the fetch wrapper, against a stubbed global.fetch. No network,
// no live server, no LLM.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiBaseUrl, ErrataClient } from './client.js';

const jsonResponse = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('apiBaseUrl', () => {
  afterEach(() => {
    delete process.env.ERRATA_API_URL;
  });
  it('defaults to the port apps/api binds by default', () => {
    expect(apiBaseUrl()).toBe('http://127.0.0.1:8787');
  });
  it('honors ERRATA_API_URL', () => {
    process.env.ERRATA_API_URL = 'http://127.0.0.1:9999';
    expect(apiBaseUrl()).toBe('http://127.0.0.1:9999');
  });
});

describe('ErrataClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('get() serializes query params and reports ok/status for a 2xx', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { belief: null }));
    const client = new ErrataClient('http://127.0.0.1:8787');
    const res = await client.get('/api/belief', { subject: 'the user', attribute: 'x', history_id: undefined });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ belief: null });
    const calledUrl = String(fetchSpy.mock.calls[0]![0]);
    expect(calledUrl).toContain('/api/belief?subject=the+user&attribute=x');
    expect(calledUrl).not.toContain('history_id'); // undefined params are dropped, not sent as "undefined"
  });

  it('post() never throws on a structured 4xx — the tool layer decides what to do with it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(404, { error: 'unknown subject/attribute' }));
    const client = new ErrataClient('http://127.0.0.1:8787');
    const res = await client.post('/api/correction', { subject: 's', attribute: 'a', value: 'v' });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'unknown subject/attribute' });
  });
});
