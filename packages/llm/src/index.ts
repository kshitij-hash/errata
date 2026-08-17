// @errata/llm — OpenRouter chat client + append-only cost ledger + budget guard (ledger design).
//
// The one door to any LLM in Errata: LLM calls go only through OpenRouterClient, and every call
// writes the ledger. Nothing here runs inside vitest against the network — `fetch` is injected.

export const version = '0.0.0';

// models / config
export {
  CONCURRENCY_HARD_CAP,
  applyEnvOverrides,
  parseModelsConfig,
  readModelsConfig,
  resolveConfigPath,
  loadModelsConfig,
  resetModelsConfigCache,
  roleConfig,
  priceOf,
} from './models.js';
export type { ModelsConfig, RoleConfig, Price } from './models.js';

// budget guard
export {
  BUDGET_STATES,
  WARN_RATIO,
  THROTTLE_RATIO,
  THROTTLE_ALLOWED_ROLE,
  BudgetExhausted,
  BudgetThrottled,
  budgetState,
  budgetGuard,
} from './budget.js';
export type { BudgetState, GuardResult } from './budget.js';

// cost ledger
export {
  LEDGER_STATUSES,
  COST_SOURCES,
  Ledger,
  dayStamp,
  defaultLedgerDir,
  rollupLines,
  readLedger,
  rollup,
  resetLedgerReadCache,
} from './ledger.js';
export type {
  LedgerLine,
  LedgerSink,
  LedgerStatus,
  CostSource,
  Rollup,
  RollupBucket,
  RoleBucket,
  ModelBucket,
} from './ledger.js';

// openrouter client
export {
  OpenRouterClient,
  Semaphore,
  globalSemaphore,
  parseRetryAfter,
  AuthError,
  TimeoutError,
  PartialError,
  UnitFailedError,
  RetryExhaustedError,
  OPENROUTER_URL,
  MAX_ATTEMPTS,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  UNIT_DEADLINE_MS,
  RETRYABLE_STATUS,
} from './openrouter.js';
export type {
  OpenRouterOptions,
  CompleteArgs,
  CompleteResult,
  ChatMessage,
  Usage,
} from './openrouter.js';
