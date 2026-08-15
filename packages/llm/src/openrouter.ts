// packages/llm/src/openrouter.ts — the OpenRouter chat client (spec 31 §6).
//
// The single door to any LLM in Errata. Every completed call writes a ledger line; every call is
// budget-guarded first; structured output is validated against a caller-supplied zod schema with a
// one-shot repair; transient failures back off with full jitter; auth failures abort the run and a
// 402 circuit-breaks to BudgetExhausted. `fetch` is dependency-injected so unit tests never touch
// the network, and the backoff sleep / clock / jitter are injectable so tests never actually wait.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { budgetGuard, BudgetExhausted, BudgetThrottled } from './budget.js';
import { Ledger } from './ledger.js';
import type { CostSource, LedgerSink, LedgerStatus } from './ledger.js';
import { CONCURRENCY_HARD_CAP, loadModelsConfig, priceOf, roleConfig } from './models.js';
import type { ModelsConfig } from './models.js';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const MAX_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CAP_MS = 30_000;
export const UNIT_DEADLINE_MS = 10 * 60 * 1000;
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  total_tokens: number;
}

export interface CompleteArgs {
  role: string;
  history_id: string;
  unit_id: string;
  run_id: string;
  messages: ChatMessage[];
  /** optional zod schema; presence switches on structured output + validation + repair. */
  schema?: z.ZodType;
  schemaName?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface CompleteResult {
  text: string;
  json?: unknown;
  usage: Usage;
  cost_usd: number;
  cached: boolean;
}

// ---- errors ---------------------------------------------------------------

/** 401/403 — credentials are wrong; abort the whole run, no retries. */
export class AuthError extends Error {
  readonly http_status: number;
  constructor(status: number) {
    super(`OpenRouter auth failed (HTTP ${status})`);
    this.name = 'AuthError';
    this.http_status = status;
  }
}

/** A single request exceeded its per-role timeout. Retryable. */
export class TimeoutError extends Error {
  constructor(message = 'request timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** The 10-minute per-unit deadline elapsed before a usable answer. Marked PARTIAL in the ledger. */
export class PartialError extends Error {
  readonly unit_id: string;
  constructor(unit_id: string) {
    super(`unit '${unit_id}' hit the 10-minute deadline (PARTIAL)`);
    this.name = 'PartialError';
    this.unit_id = unit_id;
  }
}

/** The unit failed unrecoverably (400/422 after repair, or invalid structured output after repair). */
export class UnitFailedError extends Error {
  readonly unit_id: string;
  constructor(unit_id: string, reason: string) {
    super(`unit '${unit_id}' failed: ${reason}`);
    this.name = 'UnitFailedError';
    this.unit_id = unit_id;
  }
}

/** All transient retries were exhausted without success. */
export class RetryExhaustedError extends Error {
  readonly http_status: number;
  readonly attempts: number;
  constructor(http_status: number, attempts: number) {
    super(`transient failures exhausted ${attempts} attempts (last HTTP ${http_status})`);
    this.name = 'RetryExhaustedError';
    this.http_status = http_status;
    this.attempts = attempts;
  }
}

// ---- concurrency ----------------------------------------------------------

/** A process-wide concurrency gate shared across roles; the client sizes it from config. */
export class Semaphore {
  private limit: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(limit = 8) {
    this.limit = clampLimit(limit);
  }

  get inUse(): number {
    return this.active;
  }

  setLimit(n: number): void {
    this.limit = clampLimit(n);
    this.wake();
  }

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = (): void => {
        this.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active -= 1;
          this.wake();
        });
      };
      if (this.active < this.limit) grant();
      else this.waiters.push(grant);
    });
  }

  private wake(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (next === undefined) break;
      next();
    }
  }
}

function clampLimit(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), CONCURRENCY_HARD_CAP);
}

/** The single process-wide semaphore, shared across every client instance and role. */
export const globalSemaphore = new Semaphore(8);

// ---- client ---------------------------------------------------------------

export interface OpenRouterOptions {
  config?: ModelsConfig;
  apiKey?: string;
  /** injected fetch; defaults to the global. Unit tests pass a stub. */
  fetchImpl?: typeof fetch;
  ledger?: LedgerSink;
  ledgerDir?: string;
  /** cache dir for $0 replays; null disables the cache; undefined uses var/llm-cache. */
  cacheDir?: string | null;
  referer?: string;
  title?: string;
  semaphore?: Semaphore;
  /** running spend seed (e.g. from a prior ledger rollup); default 0. */
  initialSpent?: number;
  // injectable timing so tests neither wait nor flake:
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

interface CachedResult {
  text: string;
  json?: unknown;
  usage: Usage;
}

type FetchOutcome =
  | { kind: 'response'; status: number; text: string; retryAfterMs?: number }
  | { kind: 'neterror'; timedOut: boolean; error: unknown };

interface ORUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}
interface ORResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: ORUsage;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export class OpenRouterClient {
  readonly config: ModelsConfig;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly ledger: LedgerSink;
  private readonly cacheDir: string | null;
  private readonly referer: string;
  private readonly title: string;
  private readonly semaphore: Semaphore;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private spent: number;

  constructor(opts: OpenRouterOptions = {}) {
    this.config = opts.config ?? loadModelsConfig();
    this.apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? '';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.ledger = opts.ledger ?? new Ledger({ dir: opts.ledgerDir });
    this.cacheDir =
      opts.cacheDir === undefined ? join(process.cwd(), 'var', 'llm-cache') : opts.cacheDir;
    this.referer = opts.referer ?? process.env.OPENROUTER_REFERER ?? 'https://errata.local';
    this.title = opts.title ?? 'Errata';
    this.semaphore = opts.semaphore ?? globalSemaphore;
    this.semaphore.setLimit(this.config.concurrency);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.spent = opts.initialSpent ?? 0;
  }

  /** Running spend this client has observed (seed + all completed costs). */
  get spentUsd(): number {
    return round6(this.spent);
  }

  /** Full-jitter exponential backoff for transient attempt `attempt` (1-based). */
  backoffMs(attempt: number): number {
    const ceil = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
    return Math.floor(this.random() * ceil);
  }

  async complete(args: CompleteArgs): Promise<CompleteResult> {
    const cap = this.config.budget_cap_usd;
    const roleCfg = roleConfig(this.config, args.role);
    const model = roleCfg.model;
    const schemaJson = args.schema ? z.toJSONSchema(args.schema) : undefined;

    // $0 replay: a prior identical prompt short-circuits before any fetch.
    const cacheKey = this.cacheKeyFor(model, args.messages, schemaJson);
    const cached = this.readCache(cacheKey);
    if (cached !== undefined) {
      this.record(args, model, {
        status: 'ok',
        http_status: 200,
        attempt: 0,
        latency_ms: 0,
        cost_usd: 0,
        cost_source: 'cache',
        usage: { ...cached.usage, cached_tokens: cached.usage.prompt_tokens },
      });
      return { text: cached.text, json: cached.json, usage: cached.usage, cost_usd: 0, cached: true };
    }

    let messages: ChatMessage[] = [...args.messages];
    let repaired = false;
    let attempt = 0;
    const start = this.now();

    for (;;) {
      // per-unit deadline: refuse to start another attempt past 10 minutes.
      if (this.now() - start >= UNIT_DEADLINE_MS) {
        this.record(args, model, {
          status: 'partial',
          http_status: 0,
          attempt,
          latency_ms: this.now() - start,
          cost_usd: 0,
        });
        throw new PartialError(args.unit_id);
      }

      // budget guard: throws BudgetExhausted at the cap; blocks extraction while THROTTLED.
      const guard = budgetGuard(this.spent, cap, args.role);
      if (!guard.allow) throw new BudgetThrottled(args.role, this.spent, cap);

      attempt += 1;
      const body = this.buildBody(model, messages, repaired ? undefined : schemaJson, args);
      const t0 = this.now();
      const release = await this.semaphore.acquire();
      let outcome: FetchOutcome;
      try {
        outcome = await this.doFetch(body, roleCfg.timeout_ms);
      } finally {
        release();
      }
      const latency = this.now() - t0;

      // --- network error / timeout: retryable ---
      if (outcome.kind === 'neterror') {
        this.record(args, model, {
          status: 'retry',
          http_status: 0,
          attempt,
          latency_ms: latency,
          cost_usd: 0,
        });
        if (attempt >= MAX_ATTEMPTS) throw new RetryExhaustedError(0, attempt);
        if (this.now() - start >= UNIT_DEADLINE_MS) continue; // let the top-of-loop mark PARTIAL
        await this.sleep(this.backoffMs(attempt));
        continue;
      }

      const { status, text, retryAfterMs } = outcome;

      // --- auth: abort the run, no retry ---
      if (status === 401 || status === 403) {
        this.record(args, model, {
          status: 'error',
          http_status: status,
          attempt,
          latency_ms: latency,
          cost_usd: 0,
        });
        throw new AuthError(status);
      }

      // --- payment required: circuit-break to BudgetExhausted, never retry ---
      if (status === 402) {
        this.record(args, model, {
          status: 'error',
          http_status: 402,
          attempt,
          latency_ms: latency,
          cost_usd: 0,
        });
        throw new BudgetExhausted(this.spent, cap, 'OpenRouter 402 payment required');
      }

      // --- bad request / unprocessable: one repair retry, then fail the unit ---
      if (status === 400 || status === 422) {
        if (!repaired) {
          repaired = true;
          messages = this.appendRepair(messages, `HTTP ${status}: ${truncate(text)}`, schemaJson);
          this.record(args, model, {
            status: 'retry',
            http_status: status,
            attempt,
            latency_ms: latency,
            cost_usd: 0,
          });
          continue;
        }
        this.record(args, model, {
          status: 'error',
          http_status: status,
          attempt,
          latency_ms: latency,
          cost_usd: 0,
        });
        throw new UnitFailedError(args.unit_id, `HTTP ${status} after repair`);
      }

      // --- transient server / rate-limit: back off (honoring Retry-After) ---
      if (RETRYABLE_STATUS.has(status)) {
        this.record(args, model, {
          status: 'retry',
          http_status: status,
          attempt,
          latency_ms: latency,
          cost_usd: 0,
        });
        if (attempt >= MAX_ATTEMPTS) throw new RetryExhaustedError(status, attempt);
        if (this.now() - start >= UNIT_DEADLINE_MS) continue; // let the top-of-loop mark PARTIAL
        await this.sleep(retryAfterMs ?? this.backoffMs(attempt));
        continue;
      }

      // --- any other non-2xx: fail the unit ---
      if (status < 200 || status >= 300) {
        this.record(args, model, {
          status: 'error',
          http_status: status,
          attempt,
          latency_ms: latency,
          cost_usd: 0,
        });
        throw new UnitFailedError(args.unit_id, `HTTP ${status}: ${truncate(text)}`);
      }

      // --- 2xx: parse, cost, validate ---
      let parsed: ORResponse | undefined;
      try {
        parsed = JSON.parse(text) as ORResponse;
      } catch {
        parsed = undefined;
      }
      if (parsed === undefined) {
        if (!repaired) {
          repaired = true;
          messages = this.appendRepair(messages, 'response body was not valid JSON', schemaJson);
          this.record(args, model, {
            status: 'retry',
            http_status: 200,
            attempt,
            latency_ms: latency,
            cost_usd: 0,
          });
          continue;
        }
        this.record(args, model, {
          status: 'error',
          http_status: 200,
          attempt,
          latency_ms: latency,
          cost_usd: 0,
        });
        throw new UnitFailedError(args.unit_id, 'non-JSON response after repair');
      }

      const contentText = extractText(parsed);
      const usage = extractUsage(parsed);
      const { cost_usd, cost_source } = this.costOf(parsed, model, usage);

      let json: unknown;
      if (args.schema !== undefined) {
        let candidate: unknown;
        try {
          candidate = JSON.parse(contentText);
        } catch {
          candidate = undefined;
        }
        const result = args.schema.safeParse(candidate);
        if (!result.success) {
          if (!repaired) {
            repaired = true;
            messages = this.appendRepair(
              messages,
              `structured output failed validation: ${result.error.message}`,
              schemaJson,
            );
            this.record(args, model, {
              status: 'retry',
              http_status: 200,
              attempt,
              latency_ms: latency,
              cost_usd: 0,
            });
            continue;
          }
          this.record(args, model, {
            status: 'error',
            http_status: 200,
            attempt,
            latency_ms: latency,
            cost_usd: 0,
          });
          throw new UnitFailedError(args.unit_id, 'structured output invalid after repair');
        }
        json = result.data as unknown;
      }

      // success — the only place a real cost is recorded and running spend advances.
      const overDeadline = this.now() - start >= UNIT_DEADLINE_MS;
      this.spent += cost_usd;
      this.record(args, model, {
        status: overDeadline ? 'partial' : 'ok',
        http_status: 200,
        attempt,
        latency_ms: latency,
        cost_usd,
        cost_source,
        usage,
      });
      const out: CompleteResult = { text: contentText, json, usage, cost_usd, cached: false };
      this.writeCache(cacheKey, { text: contentText, json, usage });
      return out;
    }
  }

  // ---- internals ----------------------------------------------------------

  private buildBody(
    model: string,
    messages: ChatMessage[],
    schemaJson: unknown,
    args: CompleteArgs,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = { model, messages, usage: { include: true } };
    if (args.maxTokens !== undefined) body.max_tokens = args.maxTokens;
    if (args.temperature !== undefined) body.temperature = args.temperature;
    if (schemaJson !== undefined) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: args.schemaName ?? 'result', strict: true, schema: schemaJson },
      };
    }
    return body;
  }

  private async doFetch(body: Record<string, unknown>, timeoutMs: number): Promise<FetchOutcome> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const res = await this.fetchImpl(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': this.referer,
          'X-Title': this.title,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), this.now);
      return retryAfterMs === undefined
        ? { kind: 'response', status: res.status, text }
        : { kind: 'response', status: res.status, text, retryAfterMs };
    } catch (error) {
      return { kind: 'neterror', timedOut, error };
    } finally {
      clearTimeout(timer);
    }
  }

  private appendRepair(messages: ChatMessage[], errText: string, schemaJson: unknown): ChatMessage[] {
    const instruction =
      schemaJson !== undefined
        ? `Your previous response was rejected: ${errText}. Respond with ONLY a JSON value that ` +
          `validates against this JSON Schema — no prose, no code fences:\n${JSON.stringify(schemaJson)}`
        : `Your previous request was rejected: ${errText}. Correct the output and respond again.`;
    return [...messages, { role: 'user', content: instruction }];
  }

  private costOf(
    parsed: ORResponse,
    model: string,
    usage: Usage,
  ): { cost_usd: number; cost_source: CostSource } {
    const reported = parsed.usage?.cost;
    if (typeof reported === 'number' && Number.isFinite(reported)) {
      return { cost_usd: round6(reported), cost_source: 'usage' };
    }
    const price = priceOf(this.config, model);
    const cost =
      (usage.prompt_tokens / 1e6) * price.in_per_mtok +
      (usage.completion_tokens / 1e6) * price.out_per_mtok;
    return { cost_usd: round6(cost), cost_source: 'table' };
  }

  private record(
    args: CompleteArgs,
    model: string,
    o: {
      status: LedgerStatus;
      http_status: number;
      attempt: number;
      latency_ms: number;
      cost_usd: number;
      cost_source?: CostSource;
      usage?: Usage;
    },
  ): void {
    const u = o.usage;
    this.ledger.append({
      ts: new Date(this.now()).toISOString(),
      run_id: args.run_id,
      role: args.role,
      model,
      history_id: args.history_id,
      unit_id: args.unit_id,
      prompt_tokens: u?.prompt_tokens ?? 0,
      completion_tokens: u?.completion_tokens ?? 0,
      cached_tokens: u?.cached_tokens ?? 0,
      cost_usd: o.cost_usd,
      latency_ms: o.latency_ms,
      status: o.status,
      attempt: o.attempt,
      http_status: o.http_status,
      ...(o.cost_source !== undefined ? { cost_source: o.cost_source } : {}),
    });
  }

  private cacheKeyFor(model: string, messages: ChatMessage[], schemaJson: unknown): string {
    const canonical = JSON.stringify({ model, messages, schema: schemaJson ?? null });
    return createHash('sha256').update(canonical).digest('hex');
  }

  private readCache(key: string): CachedResult | undefined {
    if (this.cacheDir === null) return undefined;
    try {
      return JSON.parse(readFileSync(join(this.cacheDir, `${key}.json`), 'utf8')) as CachedResult;
    } catch {
      return undefined;
    }
  }

  private writeCache(key: string, value: CachedResult): void {
    if (this.cacheDir === null) return;
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(join(this.cacheDir, `${key}.json`), JSON.stringify(value));
    } catch {
      // cache is best-effort; a write failure must not fail the call
    }
  }
}

// ---- pure helpers ---------------------------------------------------------

function extractText(parsed: ORResponse): string {
  const content = parsed.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

function extractUsage(parsed: ORResponse): Usage {
  const u = parsed.usage ?? {};
  return {
    prompt_tokens: num(u.prompt_tokens),
    completion_tokens: num(u.completion_tokens),
    cached_tokens: num(u.prompt_tokens_details?.cached_tokens),
    total_tokens: num(u.total_tokens),
  };
}

/** Retry-After → ms. Numeric = seconds (exact); HTTP-date = delta from now; else undefined. */
export function parseRetryAfter(value: string | null, now: () => number): number | undefined {
  if (value === null) return undefined;
  const s = value.trim();
  if (s === '') return undefined;
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const when = Date.parse(s);
  if (!Number.isNaN(when)) return Math.max(0, when - now());
  return undefined;
}

function truncate(s: string, n = 500): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}
