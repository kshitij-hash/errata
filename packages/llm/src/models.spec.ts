import { describe, it, expect } from 'vitest';
import {
  parseModelsConfig,
  applyEnvOverrides,
  readModelsConfig,
  resolveConfigPath,
  roleConfig,
  priceOf,
  CONCURRENCY_HARD_CAP,
} from './models.js';
import type { ModelsConfig } from './models.js';

const GEMINI = 'google/gemini-2.0-flash-001';
const CLAUDE = 'anthropic/claude-3.5-sonnet';

const RAW = {
  concurrency: 8,
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

describe('parseModelsConfig', () => {
  it('validates and returns a typed config with no env overrides', () => {
    const cfg = parseModelsConfig(RAW, {});
    expect(cfg.concurrency).toBe(8);
    expect(cfg.budget_cap_usd).toBe(50);
    expect(cfg.roles.extractor?.model).toBe(GEMINI);
  });

  it('rejects a malformed config', () => {
    expect(() => parseModelsConfig({ concurrency: 0, roles: {}, prices: {} }, {})).toThrow();
    expect(() => parseModelsConfig({ ...RAW, budget_cap_usd: -1 }, {})).toThrow();
  });
});

describe('applyEnvOverrides', () => {
  const base: ModelsConfig = parseModelsConfig(RAW, {});

  it('ERRATA_BUDGET_CAP overrides the cap', () => {
    expect(applyEnvOverrides(base, { ERRATA_BUDGET_CAP: '12.5' }).budget_cap_usd).toBe(12.5);
  });

  it('ERRATA_LLM_CONCURRENCY overrides concurrency', () => {
    expect(applyEnvOverrides(base, { ERRATA_LLM_CONCURRENCY: '3' }).concurrency).toBe(3);
  });

  it('concurrency is hard-capped at 32 from env and from the file', () => {
    expect(applyEnvOverrides(base, { ERRATA_LLM_CONCURRENCY: '999' }).concurrency).toBe(CONCURRENCY_HARD_CAP);
    expect(parseModelsConfig({ ...RAW, concurrency: 1000 }, {}).concurrency).toBe(CONCURRENCY_HARD_CAP);
  });

  it('ignores blank / non-numeric env values', () => {
    expect(applyEnvOverrides(base, { ERRATA_BUDGET_CAP: '', ERRATA_LLM_CONCURRENCY: 'abc' })).toMatchObject({
      budget_cap_usd: 50,
      concurrency: 8,
    });
  });
});

describe('lookups', () => {
  const cfg = parseModelsConfig(RAW, {});
  it('roleConfig / priceOf resolve pinned entries', () => {
    expect(roleConfig(cfg, 'judge').timeout_ms).toBe(30_000);
    expect(priceOf(cfg, GEMINI).out_per_mtok).toBe(0.4);
  });
  it('throw on an unknown role or model', () => {
    expect(() => roleConfig(cfg, 'nope')).toThrow(/no config for role/);
    expect(() => priceOf(cfg, 'nope/model')).toThrow(/no price for model/);
  });
});

describe('config/models.json on disk', () => {
  it('resolves and parses the committed pins (each Errata role present and priced)', () => {
    const cfg = readModelsConfig(resolveConfigPath(), {});
    for (const role of ['extractor', 'judge', 'answer'] as const) {
      expect(cfg.roles[role]?.model, `role ${role}`).toBeTruthy();
    }
    // the models Errata actually calls (extractor, judge) must carry a pinned price
    for (const role of ['extractor', 'judge'] as const) {
      const model = cfg.roles[role]!.model;
      expect(cfg.prices[model], `price for ${model}`).toBeDefined();
    }
  });
});
