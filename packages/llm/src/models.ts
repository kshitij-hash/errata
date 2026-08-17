// packages/llm/src/models.ts — model roles + pinned config (ledger design).
//
// config/models.json is the single source of truth for role→model mapping, per-role timeouts,
// the price table, the process-wide concurrency, and the budget cap. These pins are placeholders
// the lead confirms; nothing downstream may hardcode a model id or a price — it reads them here.
// Env overrides: ERRATA_BUDGET_CAP (usd), ERRATA_LLM_CONCURRENCY (hard-capped at 32).

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as z from 'zod';

/** Absolute hard cap on the shared concurrency semaphore, regardless of config/env. */
export const CONCURRENCY_HARD_CAP = 32;

const RoleConfigSchema = z.object({
  model: z.string().min(1),
  timeout_ms: z.number().int().positive(),
});

const PriceSchema = z.object({
  in_per_mtok: z.number().nonnegative(),
  out_per_mtok: z.number().nonnegative(),
});

const ModelsConfigSchema = z.object({
  concurrency: z.number().int().positive(),
  budget_cap_usd: z.number().positive(),
  roles: z.record(z.string(), RoleConfigSchema),
  prices: z.record(z.string(), PriceSchema),
});

export type RoleConfig = z.infer<typeof RoleConfigSchema>;
export type Price = z.infer<typeof PriceSchema>;
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

function clampConcurrency(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), CONCURRENCY_HARD_CAP);
}

/** Apply ERRATA_BUDGET_CAP / ERRATA_LLM_CONCURRENCY over a parsed config, clamping concurrency. */
export function applyEnvOverrides(cfg: ModelsConfig, env: NodeJS.ProcessEnv = process.env): ModelsConfig {
  const out: ModelsConfig = {
    ...cfg,
    concurrency: clampConcurrency(cfg.concurrency),
  };

  const capRaw = env.ERRATA_BUDGET_CAP;
  if (capRaw !== undefined && capRaw !== '') {
    const cap = Number(capRaw);
    if (Number.isFinite(cap) && cap > 0) out.budget_cap_usd = cap;
  }

  const concRaw = env.ERRATA_LLM_CONCURRENCY;
  if (concRaw !== undefined && concRaw !== '') {
    const conc = Number(concRaw);
    if (Number.isFinite(conc) && conc >= 1) out.concurrency = clampConcurrency(conc);
  }

  return out;
}

/** Parse + validate a raw config object, then apply env overrides. Pure (no filesystem). */
export function parseModelsConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): ModelsConfig {
  const parsed = ModelsConfigSchema.parse(raw);
  return applyEnvOverrides(parsed, env);
}

/** Walk up from a starting dir until a `config/models.json` is found; returns its absolute path. */
export function resolveConfigPath(startDir: string = import.meta.dirname): string {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, 'config', 'models.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('models: could not locate config/models.json (searched upward from ' + startDir + ')');
}

/** Read + parse a config file at an explicit path (no memoization). */
export function readModelsConfig(path: string, env: NodeJS.ProcessEnv = process.env): ModelsConfig {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parseModelsConfig(raw, env);
}

let cached: ModelsConfig | undefined;

/** Load the default config once at startup and memoize it. */
export function loadModelsConfig(): ModelsConfig {
  if (cached === undefined) cached = readModelsConfig(resolveConfigPath());
  return cached;
}

/** Test-only: drop the memoized default so a subsequent load re-reads the file. */
export function resetModelsConfigCache(): void {
  cached = undefined;
}

/** Look up a role's config; throws if the role is not pinned. */
export function roleConfig(cfg: ModelsConfig, role: string): RoleConfig {
  const rc = cfg.roles[role];
  if (rc === undefined) throw new Error(`models: no config for role '${role}'`);
  return rc;
}

/** Look up a model's price; throws if the model is not in the price table. */
export function priceOf(cfg: ModelsConfig, model: string): Price {
  const p = cfg.prices[model];
  if (p === undefined) throw new Error(`models: no price for model '${model}'`);
  return p;
}
