import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import {
  OpenRouterClient,
  Semaphore,
  AuthError,
  PartialError,
  UnitFailedError,
} from './openrouter.js';
import { BudgetExhausted } from './budget.js';
import type { ModelsConfig } from './models.js';
import type { LedgerLine } from './ledger.js';

const GEMINI = 'google/gemini-2.0-flash-001';
const CLAUDE = 'anthropic/claude-3.5-sonnet';

const CONFIG: ModelsConfig = {
  concurrency: 4,
  budget_cap_usd: 50,
  roles: {
    extractor: { model: GEMINI, timeout_ms: 60_000 },
    judge: { model: CLAUDE, timeout_ms: 30_000 },
  },
  prices: {
    [GEMINI]: { in_per_mtok: 0.1, out_per_mtok: 0.4 },
    [CLAUDE]: { in_per_mtok: 3.0, out_per_mtok: 15.0 },
  },
};

const BASE_ARGS = {
  role: 'extractor',
  history_id: 'h1',
  unit_id: 'u1',
  run_id: 'r1',
  messages: [{ role: 'user' as const, content: 'hi' }],
};

interface OkBodyOpts {
  content?: string;
  cost?: number;
  prompt?: number;
  completion?: number;
  cached?: number;
}
function okBody(o: OkBodyOpts = {}): unknown {
  const prompt = o.prompt ?? 1000;
  const completion = o.completion ?? 200;
  const usage: Record<string, unknown> = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
  if (o.cost !== undefined) usage.cost = o.cost;
  if (o.cached !== undefined) usage.prompt_tokens_details = { cached_tokens: o.cached };
  return { choices: [{ message: { content: o.content ?? 'hello world' } }], usage };
}
function jsonResponse(status: number, obj: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), { status, headers });
}

type Responder = Response | (() => Response | Promise<Response>);
interface Stub {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
}
function queueFetch(responses: Responder[]): Stub {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetchImpl = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    const r = responses[i++];
    if (r === undefined) throw new Error('queueFetch: no more responses queued');
    return typeof r === 'function' ? await r() : r;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

interface Harness {
  client: OpenRouterClient;
  lines: LedgerLine[];
  sleeps: number[];
}
function makeClient(fetchImpl: typeof fetch, over: Partial<ConstructorParameters<typeof OpenRouterClient>[0]> = {}): Harness {
  const lines: LedgerLine[] = [];
  const sleeps: number[] = [];
  const client = new OpenRouterClient({
    config: CONFIG,
    apiKey: 'test-key',
    fetchImpl,
    ledger: { append: (l) => lines.push(l) },
    cacheDir: null,
    semaphore: new Semaphore(4),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 0,
    random: () => 0,
    ...over,
  });
  return { client, lines, sleeps };
}

function bodyOf(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

describe('OpenRouterClient.complete — happy path', () => {
  it('returns the completion and writes one ok ledger line with cost from usage', async () => {
    const stub = queueFetch([jsonResponse(200, okBody({ cost: 0.123, prompt: 1000, completion: 200 }))]);
    const { client, lines } = makeClient(stub.fetchImpl);

    const res = await client.complete(BASE_ARGS);

    expect(res.text).toBe('hello world');
    expect(res.cost_usd).toBe(0.123);
    expect(res.cached).toBe(false);
    expect(stub.calls).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      status: 'ok',
      http_status: 200,
      attempt: 1,
      cost_usd: 0.123,
      cost_source: 'usage',
      prompt_tokens: 1000,
      completion_tokens: 200,
      role: 'extractor',
      model: GEMINI,
      run_id: 'r1',
      unit_id: 'u1',
    });
  });

  it('sends usage.include and the Errata identity headers', async () => {
    const stub = queueFetch([jsonResponse(200, okBody({ cost: 0.01 }))]);
    const { client } = makeClient(stub.fetchImpl);
    await client.complete(BASE_ARGS);

    const body = bodyOf(stub.calls[0]!);
    expect(body.usage).toEqual({ include: true });
    expect(body.model).toBe(GEMINI);
    const headers = stub.calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-Title']).toBe('Errata');
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers['HTTP-Referer']).toBeDefined();
  });
});

describe('OpenRouterClient.complete — retry / abort semantics', () => {
  it('429 then 200 retries and succeeds (two calls, first line is a retry)', async () => {
    const stub = queueFetch([
      jsonResponse(429, { error: 'rate limited' }),
      jsonResponse(200, okBody({ cost: 0.2 })),
    ]);
    const { client, lines } = makeClient(stub.fetchImpl);

    const res = await client.complete(BASE_ARGS);

    expect(res.cost_usd).toBe(0.2);
    expect(stub.calls).toHaveLength(2);
    expect(lines.map((l) => l.status)).toEqual(['retry', 'ok']);
    expect(lines[0]).toMatchObject({ status: 'retry', http_status: 429, cost_usd: 0 });
    expect(lines[1]).toMatchObject({ status: 'ok', attempt: 2, cost_usd: 0.2 });
  });

  it('honors Retry-After exactly (2s → 2000ms sleep, not backoff)', async () => {
    const stub = queueFetch([
      jsonResponse(429, {}, { 'retry-after': '2' }),
      jsonResponse(200, okBody({ cost: 0.05 })),
    ]);
    const { client, sleeps } = makeClient(stub.fetchImpl);
    await client.complete(BASE_ARGS);
    expect(sleeps).toEqual([2000]);
  });

  it('401 aborts the run immediately with AuthError and no retry', async () => {
    const stub = queueFetch([jsonResponse(401, { error: 'bad key' })]);
    const { client, lines } = makeClient(stub.fetchImpl);

    await expect(client.complete(BASE_ARGS)).rejects.toBeInstanceOf(AuthError);
    expect(stub.calls).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: 'error', http_status: 401, cost_usd: 0 });
  });

  it('402 circuit-breaks to BudgetExhausted with no retry', async () => {
    const stub = queueFetch([jsonResponse(402, { error: 'payment required' })]);
    const { client, lines } = makeClient(stub.fetchImpl);

    await expect(client.complete(BASE_ARGS)).rejects.toBeInstanceOf(BudgetExhausted);
    expect(stub.calls).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: 'error', http_status: 402 });
  });

  it('gives up after 5 transient attempts', async () => {
    const stub = queueFetch([
      jsonResponse(503, {}),
      jsonResponse(503, {}),
      jsonResponse(503, {}),
      jsonResponse(503, {}),
      jsonResponse(503, {}),
    ]);
    const { client, lines } = makeClient(stub.fetchImpl);
    await expect(client.complete(BASE_ARGS)).rejects.toThrow(/exhausted 5 attempts/);
    expect(stub.calls).toHaveLength(5);
    expect(lines.every((l) => l.status === 'retry')).toBe(true);
  });

  it('marks PARTIAL when the 10-minute deadline elapses mid-retry', async () => {
    let clock = 0;
    const stub = queueFetch([
      () => {
        clock = 11 * 60 * 1000; // jump past the 10-min deadline while serving the first attempt
        return jsonResponse(429, {});
      },
    ]);
    const { client, lines } = makeClient(stub.fetchImpl, { now: () => clock });

    await expect(client.complete(BASE_ARGS)).rejects.toBeInstanceOf(PartialError);
    expect(stub.calls).toHaveLength(1);
    expect(lines.map((l) => l.status)).toEqual(['retry', 'partial']);
  });
});

describe('OpenRouterClient.complete — structured output', () => {
  const schema = z.object({ name: z.string() });

  it('a schema-invalid body triggers exactly one repair retry, then succeeds', async () => {
    const stub = queueFetch([
      jsonResponse(200, okBody({ content: '{"wrong": true}', cost: 0.1 })), // fails: no `name`
      jsonResponse(200, okBody({ content: '{"name":"ok"}', cost: 0.1 })),
    ]);
    const { client, lines } = makeClient(stub.fetchImpl);

    const res = await client.complete({ ...BASE_ARGS, schema });

    expect(res.json).toEqual({ name: 'ok' });
    expect(stub.calls).toHaveLength(2); // exactly one repair
    expect(lines.map((l) => l.status)).toEqual(['retry', 'ok']);

    // first request carries response_format; the repair drops it and appends a corrective message
    const first = bodyOf(stub.calls[0]!);
    const second = bodyOf(stub.calls[1]!);
    expect(first.response_format).toBeDefined();
    expect(second.response_format).toBeUndefined();
    expect((second.messages as unknown[]).length).toBeGreaterThan((first.messages as unknown[]).length);
  });

  it('fails the unit when structured output is still invalid after the one repair', async () => {
    const stub = queueFetch([
      jsonResponse(200, okBody({ content: '{"wrong": 1}' })),
      jsonResponse(200, okBody({ content: 'still not valid' })),
    ]);
    const { client, lines } = makeClient(stub.fetchImpl);

    await expect(client.complete({ ...BASE_ARGS, schema })).rejects.toBeInstanceOf(UnitFailedError);
    expect(stub.calls).toHaveLength(2);
    expect(lines.map((l) => l.status)).toEqual(['retry', 'error']);
  });
});

describe('OpenRouterClient.complete — cost source + cache', () => {
  it('falls back to the price table when usage.cost is absent (cost_source table)', async () => {
    // 1M prompt + 1M completion tokens → 1*0.10 + 1*0.40 = 0.50 at the extractor price
    const stub = queueFetch([jsonResponse(200, okBody({ prompt: 1_000_000, completion: 1_000_000 }))]);
    const { client, lines } = makeClient(stub.fetchImpl);

    const res = await client.complete(BASE_ARGS);

    expect(res.cost_usd).toBe(0.5);
    expect(lines[0]).toMatchObject({ cost_usd: 0.5, cost_source: 'table' });
  });

  it('returns a cached result on replay without a second fetch ($0)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'errata-llmcache-'));
    try {
      const stub = queueFetch([jsonResponse(200, okBody({ content: 'cached!', cost: 0.9 }))]);
      const { client, lines } = makeClient(stub.fetchImpl, { cacheDir: dir });

      const first = await client.complete(BASE_ARGS);
      expect(first.cached).toBe(false);
      expect(first.cost_usd).toBe(0.9);
      expect(stub.calls).toHaveLength(1);

      const second = await client.complete(BASE_ARGS);
      expect(second.cached).toBe(true);
      expect(second.cost_usd).toBe(0);
      expect(second.text).toBe('cached!');
      expect(stub.calls).toHaveLength(1); // no second fetch

      expect(lines.map((l) => l.cost_source)).toEqual(['usage', 'cache']);
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('backoff + semaphore', () => {
  it('backoffMs is full-jitter exponential, capped at 30s', () => {
    const stub = queueFetch([]);
    const { client } = makeClient(stub.fetchImpl, { random: () => 1 });
    expect(client.backoffMs(1)).toBe(1000); // 1000 * 2^0
    expect(client.backoffMs(2)).toBe(2000);
    expect(client.backoffMs(3)).toBe(4000);
    expect(client.backoffMs(10)).toBe(30_000); // capped
  });

  it('full jitter scales the ceiling by random()', () => {
    const stub = queueFetch([]);
    const { client } = makeClient(stub.fetchImpl, { random: () => 0.5 });
    expect(client.backoffMs(1)).toBe(500);
    expect(client.backoffMs(5)).toBe(8000); // 0.5 * min(30000, 16000)
  });

  it('Semaphore gates concurrency and releases in order', async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    await sem.acquire();
    let third = false;
    void sem.acquire().then(() => {
      third = true;
    });
    await Promise.resolve();
    expect(third).toBe(false); // both slots taken
    r1();
    await Promise.resolve();
    expect(third).toBe(true); // freeing one wakes the waiter
  });
});
