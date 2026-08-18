import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { rateLimit } from './ratelimit.js';

/** A throwaway app carrying the middleware under test, with the clock and the key both injected —
 *  no sockets, no sleeping, and no dependence on the real app's route table. */
function harness(opts: { limit: number; windowMs?: number; clock: { t: number } }) {
  const app = new Hono();
  app.use(
    '*',
    rateLimit({
      limit: opts.limit,
      windowMs: opts.windowMs ?? 60_000,
      now: () => opts.clock.t,
      keyOf: (c) => c.req.header('x-test-key') ?? 'anon',
    }),
  );
  app.get('/thing', (c) => c.json({ ok: true }));
  const get = (key = 'a') => app.request('/thing', { headers: { 'x-test-key': key } });
  return { app, get };
}

describe('rateLimit', () => {
  it('passes requests up to the limit and refuses the one after it', async () => {
    const clock = { t: 1_000 };
    const { get } = harness({ limit: 3, clock });
    for (let i = 0; i < 3; i++) expect((await get()).status).toBe(200);
    const over = await get();
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: 'rate limit exceeded' });
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('counts each key separately', async () => {
    const clock = { t: 1_000 };
    const { get } = harness({ limit: 1, clock });
    expect((await get('a')).status).toBe(200);
    expect((await get('a')).status).toBe(429);
    expect((await get('b')).status).toBe(200); // b's own window is untouched by a's flood
  });

  it('re-opens the key once its window has rolled', async () => {
    const clock = { t: 1_000 };
    const { get } = harness({ limit: 1, windowMs: 60_000, clock });
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(429);
    clock.t += 59_999;
    expect((await get()).status).toBe(429); // still inside the window
    clock.t += 1;
    expect((await get()).status).toBe(200); // window rolled
  });

  it('exempts loopback callers, so the eval harness and the ingest CLI are never capped', async () => {
    const clock = { t: 1_000 };
    const { get } = harness({ limit: 1, clock });
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      for (let i = 0; i < 5; i++) expect((await get(addr)).status).toBe(200);
    }
  });

  it('defaults to 60 per minute', async () => {
    const clock = { t: 0 };
    const app = new Hono();
    app.use('*', rateLimit({ now: () => clock.t, keyOf: () => 'fixed' }));
    app.get('/thing', (c) => c.json({ ok: true }));
    for (let i = 0; i < 60; i++) expect((await app.request('/thing')).status).toBe(200);
    expect((await app.request('/thing')).status).toBe(429);
  });
});
