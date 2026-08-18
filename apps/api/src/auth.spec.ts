import { describe, it, expect, afterEach } from 'vitest';
import { Hono } from 'hono';
import { app } from './app.js';
import { WRITE_KEY_HEADER, writeKeyGuard } from './auth.js';

function harness() {
  const guarded = new Hono();
  guarded.use('*', writeKeyGuard());
  guarded.post('/w', (c) => c.json({ wrote: true }, 201));
  return (headers: Record<string, string> = {}) => guarded.request('/w', { method: 'POST', headers });
}

afterEach(() => {
  delete process.env.ERRATA_WRITE_KEY;
});

describe('writeKeyGuard', () => {
  it('is open when ERRATA_WRITE_KEY is unset (local dev, vitest, the eval harness)', async () => {
    delete process.env.ERRATA_WRITE_KEY;
    expect((await harness()()).status).toBe(201);
  });

  it('refuses a request with no key once one is configured', async () => {
    process.env.ERRATA_WRITE_KEY = 's3cret';
    const res = await harness()();
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  it('refuses a wrong key, including one that is merely a prefix', async () => {
    process.env.ERRATA_WRITE_KEY = 's3cret';
    const post = harness();
    expect((await post({ [WRITE_KEY_HEADER]: 'nope' })).status).toBe(401);
    expect((await post({ [WRITE_KEY_HEADER]: 's3cre' })).status).toBe(401);
    expect((await post({ [WRITE_KEY_HEADER]: 's3crets' })).status).toBe(401);
  });

  it('admits the exact key', async () => {
    process.env.ERRATA_WRITE_KEY = 's3cret';
    expect((await harness()({ [WRITE_KEY_HEADER]: 's3cret' })).status).toBe(201);
  });
});

describe('api — POST /api/correction is the guarded route', () => {
  it('401s without the key when one is configured, before the body is even parsed', async () => {
    process.env.ERRATA_WRITE_KEY = 's3cret';
    const res = await app.request('/api/correction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'the user', attribute: 'x', value: 'y' }),
    });
    expect(res.status).toBe(401);
  });

  it('falls through to the route (400 on a bad body, no graph touched) when unconfigured', async () => {
    delete process.env.ERRATA_WRITE_KEY;
    const res = await app.request('/api/correction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400); // the validator's answer, which means the guard let it past
  });

  it('leaves the read routes ungated', async () => {
    process.env.ERRATA_WRITE_KEY = 's3cret';
    expect((await app.request('/health')).status).toBe(200);
  });
});
