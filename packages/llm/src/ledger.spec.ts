import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rollupLines,
  readLedger,
  rollup,
  resetLedgerReadCache,
  Ledger,
} from './ledger.js';
import type { LedgerLine } from './ledger.js';

const GEMINI = 'google/gemini-2.0-flash-001';
const CLAUDE = 'anthropic/claude-3.5-sonnet';

function line(p: Partial<LedgerLine>): LedgerLine {
  return {
    ts: p.ts ?? '2026-08-16T00:00:00.000Z',
    run_id: p.run_id ?? 'run-1',
    role: p.role ?? 'extractor',
    model: p.model ?? GEMINI,
    history_id: p.history_id ?? 'h1',
    unit_id: p.unit_id ?? 'u1',
    prompt_tokens: p.prompt_tokens ?? 0,
    completion_tokens: p.completion_tokens ?? 0,
    cached_tokens: p.cached_tokens ?? 0,
    cost_usd: p.cost_usd ?? 0,
    latency_ms: p.latency_ms ?? 0,
    status: p.status ?? 'ok',
    attempt: p.attempt ?? 1,
    http_status: p.http_status ?? 200,
    ...(p.cost_source !== undefined ? { cost_source: p.cost_source } : {}),
  };
}

// A → judge(x2) + extractor(x1) completed, plus one retry and one error that must count as $0.
const FIXTURE: LedgerLine[] = [
  line({ role: 'extractor', model: GEMINI, status: 'ok', prompt_tokens: 1000, completion_tokens: 500, cost_usd: 0.5, latency_ms: 100 }),
  line({ role: 'extractor', model: GEMINI, status: 'retry', http_status: 429, cost_usd: 0, latency_ms: 10 }),
  line({ role: 'judge', model: CLAUDE, status: 'ok', prompt_tokens: 2000, completion_tokens: 1000, cost_usd: 3.0, latency_ms: 200 }),
  line({ role: 'judge', model: CLAUDE, status: 'ok', prompt_tokens: 500, completion_tokens: 250, cost_usd: 1.0, latency_ms: 300 }),
  line({ role: 'extractor', model: GEMINI, status: 'error', http_status: 400, cost_usd: 0, latency_ms: 5 }),
];

describe('rollupLines (spec 31 §6 in-memory rollup)', () => {
  it('totals match the hand fixture; retry/error lines contribute 0 cost and 0 calls', () => {
    const r = rollupLines(FIXTURE, 50);
    expect(r.spent_usd).toBe(4.5); // 0.5 + 3.0 + 1.0; the retry and error add nothing
    expect(r.calls).toBe(3); // only ok|partial count as calls
    expect(r.tokens_in).toBe(3500);
    expect(r.tokens_out).toBe(1750);
    expect(r.cap_usd).toBe(50);
  });

  it('by_role rollup (sorted, per-role cost/tokens/calls)', () => {
    const r = rollupLines(FIXTURE, 50);
    expect(r.by_role.map((b) => b.role)).toEqual(['extractor', 'judge']);
    const ext = r.by_role.find((b) => b.role === 'extractor');
    const jud = r.by_role.find((b) => b.role === 'judge');
    expect(ext).toMatchObject({ calls: 1, tokens_in: 1000, tokens_out: 500, cost_usd: 0.5 });
    expect(jud).toMatchObject({ calls: 2, tokens_in: 2500, tokens_out: 1250, cost_usd: 4.0 });
  });

  it('by_model rollup (sorted by model id)', () => {
    const r = rollupLines(FIXTURE, 50);
    expect(r.by_model.map((b) => b.model)).toEqual([CLAUDE, GEMINI]); // "anthropic/" < "google/"
    const gemini = r.by_model.find((b) => b.model === GEMINI);
    const claude = r.by_model.find((b) => b.model === CLAUDE);
    expect(gemini).toMatchObject({ calls: 1, cost_usd: 0.5 });
    expect(claude).toMatchObject({ calls: 2, cost_usd: 4.0 });
  });

  it('computes latency percentiles in TS (nearest-rank)', () => {
    const r = rollupLines(FIXTURE, 50);
    expect(r.p50_latency_ms).toBe(200); // [100,200,300] → p50 = 200
    expect(r.p95_latency_ms).toBe(300);
    const jud = r.by_role.find((b) => b.role === 'judge');
    expect(jud?.p50_latency_ms).toBe(200); // [200,300]
    expect(jud?.p95_latency_ms).toBe(300);
  });

  it('derives budget_state from spent vs cap', () => {
    expect(rollupLines(FIXTURE, 50).budget_state).toBe('normal'); // 4.5/50 = 0.09
    expect(rollupLines(FIXTURE, 5).budget_state).toBe('THROTTLED'); // 4.5/5 = 0.90
    expect(rollupLines(FIXTURE, 4).budget_state).toBe('EXHAUSTED'); // 4.5 ≥ 4
  });

  it('empty input yields a zeroed rollup', () => {
    const r = rollupLines([], 50);
    expect(r).toMatchObject({ spent_usd: 0, calls: 0, tokens_in: 0, tokens_out: 0, budget_state: 'normal' });
    expect(r.by_role).toEqual([]);
    expect(r.by_model).toEqual([]);
  });
});

describe('Ledger writer + readLedger (round trip on disk)', () => {
  let dir: string;
  afterEach(() => {
    resetLedgerReadCache();
    if (dir !== undefined && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('appends JSONL to costs-YYYYMMDD.jsonl and reads it back into a matching rollup', () => {
    dir = mkdtempSync(join(tmpdir(), 'errata-ledger-'));
    const led = new Ledger({ dir, installSignalHandlers: false, flushEvery: 2 });
    for (const l of FIXTURE) led.append(l);
    led.close();

    expect(existsSync(join(dir, 'costs-20260816.jsonl'))).toBe(true);
    expect(readdirSync(dir)).toContain('costs-20260816.jsonl');

    resetLedgerReadCache();
    const lines = readLedger(dir);
    expect(lines).toHaveLength(FIXTURE.length);

    const r = rollup(dir, 50);
    expect(r.spent_usd).toBe(4.5);
    expect(r.calls).toBe(3);
  });

  it('readLedger caches within the 10s TTL and recomputes when files change', () => {
    dir = mkdtempSync(join(tmpdir(), 'errata-ledger-'));
    const led = new Ledger({ dir, installSignalHandlers: false });
    led.append(line({ cost_usd: 1, status: 'ok', prompt_tokens: 10, completion_tokens: 5 }));
    led.close();

    resetLedgerReadCache();
    let t = 1000;
    const clock = (): number => t;
    const first = readLedger(dir, clock);
    expect(first).toHaveLength(1);

    // Append a second line; within TTL and without cache reset, the cached view is stale by design.
    const led2 = new Ledger({ dir, installSignalHandlers: false });
    led2.append(line({ cost_usd: 2, status: 'ok' }));
    led2.close();

    t = 5000; // still < 10s since first read → served from cache
    expect(readLedger(dir, clock)).toHaveLength(1);

    t = 12000; // TTL elapsed → re-stat sees the changed file and re-reads
    expect(readLedger(dir, clock)).toHaveLength(2);
  });
});
