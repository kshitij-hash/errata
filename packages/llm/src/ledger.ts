// packages/llm/src/ledger.ts — the append-only cost ledger (ledger design). TS owns it; eval reads it.
//
// One JSONL line per COMPLETED call at var/ledger/costs-YYYYMMDD.jsonl (var/ is gitignored).
// Real cost is OpenRouter's reported `usage` when present, else computed from the price table and
// stamped cost_source:"table". Failed attempts are logged too — status retry|error, cost_usd 0 —
// so the record of what was tried survives. Writes fsync every 50 lines and on process exit; SIGINT
// flushes. rollup() tail-reads the JSONL and aggregates in memory (10s TTL, recompute on mtime),
// which is what /api/meta/costs serves. rollupLines() is the pure core, unit-tested without files.

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { budgetState } from './budget.js';
import type { BudgetState } from './budget.js';

export const LEDGER_STATUSES = ['ok', 'retry', 'error', 'partial'] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

export const COST_SOURCES = ['usage', 'table', 'cache'] as const;
export type CostSource = (typeof COST_SOURCES)[number];

/** One completed-or-attempted LLM call. Append-only; never mutated in place. */
export interface LedgerLine {
  ts: string; // ISO-8601 UTC — the ledger timestamp is ISO everywhere (design decision); the eval reader parses it as ISO too (ledger design)
  run_id: string;
  role: string;
  model: string;
  history_id: string;
  unit_id: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  cost_usd: number;
  latency_ms: number;
  status: LedgerStatus;
  attempt: number;
  http_status: number;
  cost_source?: CostSource;
}

/** The minimal sink the client writes to; the concrete Ledger implements it, tests can fake it. */
export interface LedgerSink {
  append(line: LedgerLine): void;
}

export interface RollupBucket {
  calls: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
}
export interface RoleBucket extends RollupBucket {
  role: string;
}
export interface ModelBucket extends RollupBucket {
  model: string;
}

/** What /api/meta/costs returns. Totals + percentiles are all computed here in TS. */
export interface Rollup {
  cap_usd: number;
  spent_usd: number;
  budget_state: BudgetState;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  by_role: RoleBucket[];
  by_model: ModelBucket[];
  updated_at: string;
}

/** YYYYMMDD (UTC) stamp used for the daily file name and day bucketing. */
export function dayStamp(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}${m}${day}`;
}

export function defaultLedgerDir(): string {
  return join(process.cwd(), 'var', 'ledger');
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Nearest-rank percentile over an unsorted sample; empty sample → 0. */
function percentile(sample: number[], q: number): number {
  if (sample.length === 0) return 0;
  const sorted = [...sample].sort((a, b) => a - b);
  const rank = Math.ceil(q * sorted.length);
  const idx = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[idx] as number;
}

interface Accum {
  calls: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latencies: number[];
}
function newAccum(): Accum {
  return { calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, latencies: [] };
}
function bucketOf(a: Accum): RollupBucket {
  return {
    calls: a.calls,
    tokens_in: a.tokens_in,
    tokens_out: a.tokens_out,
    cost_usd: round6(a.cost_usd),
    p50_latency_ms: percentile(a.latencies, 0.5),
    p95_latency_ms: percentile(a.latencies, 0.95),
  };
}

/**
 * Pure rollup over a set of ledger lines. spent is summed across ALL lines (retry/error carry 0,
 * so they contribute nothing); calls/tokens/latency count only COMPLETED lines (ok|partial).
 * budget_state is derived from spent vs cap. Deterministic; unit-tested without touching the disk.
 */
export function rollupLines(lines: LedgerLine[], capUsd: number): Rollup {
  let spent = 0;
  const total = newAccum();
  const byRole = new Map<string, Accum>();
  const byModel = new Map<string, Accum>();

  for (const line of lines) {
    spent += line.cost_usd;
    const completed = line.status === 'ok' || line.status === 'partial';
    if (!completed) continue;

    total.calls += 1;
    total.tokens_in += line.prompt_tokens;
    total.tokens_out += line.completion_tokens;
    total.cost_usd += line.cost_usd;
    total.latencies.push(line.latency_ms);

    let r = byRole.get(line.role);
    if (r === undefined) {
      r = newAccum();
      byRole.set(line.role, r);
    }
    r.calls += 1;
    r.tokens_in += line.prompt_tokens;
    r.tokens_out += line.completion_tokens;
    r.cost_usd += line.cost_usd;
    r.latencies.push(line.latency_ms);

    let m = byModel.get(line.model);
    if (m === undefined) {
      m = newAccum();
      byModel.set(line.model, m);
    }
    m.calls += 1;
    m.tokens_in += line.prompt_tokens;
    m.tokens_out += line.completion_tokens;
    m.cost_usd += line.cost_usd;
    m.latencies.push(line.latency_ms);
  }

  const by_role: RoleBucket[] = [...byRole.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([role, a]) => ({ role, ...bucketOf(a) }));
  const by_model: ModelBucket[] = [...byModel.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([model, a]) => ({ model, ...bucketOf(a) }));

  const spent_usd = round6(spent);
  return {
    cap_usd: capUsd,
    spent_usd,
    budget_state: budgetState(spent_usd, capUsd),
    calls: total.calls,
    tokens_in: total.tokens_in,
    tokens_out: total.tokens_out,
    p50_latency_ms: percentile(total.latencies, 0.5),
    p95_latency_ms: percentile(total.latencies, 0.95),
    by_role,
    by_model,
    updated_at: new Date().toISOString(),
  };
}

const READ_TTL_MS = 10_000;
interface ReadCacheEntry {
  lines: LedgerLine[];
  signature: string;
  readAt: number;
}
const readCache = new Map<string, ReadCacheEntry>();

/** Test-only: drop the tail-read cache so the next read hits the disk. */
export function resetLedgerReadCache(): void {
  readCache.clear();
}

/** Tail-read all costs-*.jsonl in `dir`. 10s TTL; recomputes when any file's mtime/size changes. */
export function readLedger(dir: string = defaultLedgerDir(), now: () => number = Date.now): LedgerLine[] {
  const t = now();
  const cached = readCache.get(dir);
  if (cached !== undefined && t - cached.readAt < READ_TTL_MS) return cached.lines;

  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.startsWith('costs-') && f.endsWith('.jsonl'))
      .sort();
  } catch {
    const empty: LedgerLine[] = [];
    readCache.set(dir, { lines: empty, signature: '', readAt: t });
    return empty;
  }

  const sigParts: string[] = [];
  for (const f of files) {
    const st = statSync(join(dir, f));
    sigParts.push(`${f}:${st.mtimeMs}:${st.size}`);
  }
  const signature = sigParts.join('|');
  if (cached !== undefined && cached.signature === signature) {
    cached.readAt = t;
    return cached.lines;
  }

  const lines: LedgerLine[] = [];
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const raw of text.split('\n')) {
      const s = raw.trim();
      if (s === '') continue;
      try {
        lines.push(JSON.parse(s) as LedgerLine);
      } catch {
        // ignore a torn final line
      }
    }
  }
  readCache.set(dir, { lines, signature, readAt: t });
  return lines;
}

/** Read + roll up the ledger dir. This is what /api/meta/costs calls. */
export function rollup(dir: string = defaultLedgerDir(), capUsd: number, now: () => number = Date.now): Rollup {
  return rollupLines(readLedger(dir, now), capUsd);
}

/**
 * Concrete append-only ledger writer. Holds an fd on the current day's file, fsyncs every
 * `flushEvery` lines, and flushes on process exit / SIGINT. Call close() to release the fd and
 * detach the process listeners (important in tests to avoid leaking handlers).
 */
export class Ledger implements LedgerSink {
  readonly dir: string;
  private readonly flushEvery: number;
  private fd: number | null = null;
  private currentDay = '';
  private sinceSync = 0;
  private closed = false;
  private readonly onExit: () => void;
  private readonly onSigint: () => void;
  private readonly handlersInstalled: boolean;

  constructor(opts: { dir?: string; flushEvery?: number; installSignalHandlers?: boolean } = {}) {
    this.dir = opts.dir ?? defaultLedgerDir();
    this.flushEvery = opts.flushEvery ?? 50;
    this.onExit = () => this.flush();
    this.onSigint = () => {
      this.flush();
      this.close();
      process.exit(130);
    };
    this.handlersInstalled = opts.installSignalHandlers !== false;
    if (this.handlersInstalled) {
      process.on('exit', this.onExit);
      process.on('SIGINT', this.onSigint);
    }
  }

  private ensureFd(day: string): number {
    if (this.fd !== null && this.currentDay === day) return this.fd;
    if (this.fd !== null) {
      try {
        fsyncSync(this.fd);
      } catch {
        /* best effort */
      }
      closeSync(this.fd);
      this.fd = null;
    }
    mkdirSync(this.dir, { recursive: true });
    this.fd = openSync(join(this.dir, `costs-${day}.jsonl`), 'a');
    this.currentDay = day;
    this.sinceSync = 0;
    return this.fd;
  }

  append(line: LedgerLine): void {
    if (this.closed) throw new Error('ledger: append after close');
    const fd = this.ensureFd(dayStamp(new Date(line.ts)));
    writeSync(fd, JSON.stringify(line) + '\n');
    this.sinceSync += 1;
    if (this.sinceSync >= this.flushEvery) {
      fsyncSync(fd);
      this.sinceSync = 0;
    }
  }

  /** fsync now (called every 50 lines internally, and on exit/SIGINT). */
  flush(): void {
    if (this.fd !== null) {
      try {
        fsyncSync(this.fd);
      } catch {
        /* best effort */
      }
      this.sinceSync = 0;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flush();
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
    if (this.handlersInstalled) {
      process.removeListener('exit', this.onExit);
      process.removeListener('SIGINT', this.onSigint);
    }
  }
}
