// @littlesheep/harness — public API
// The agent loop: a hard-control-flow state machine driving 10 stages.

// Context assembly (called before harness.run).
export {
  buildRunContext,
  readBootstrapFiles,
  type BuildRunContextOptions,
} from './context.js';

// Hook runner (Layer 3 primitive).
export { HookRunner } from './hooks/runner.js';

// Default Core Flow harness + registry (Layers 1/2 entry points).
export {
  createDefaultHarness,
  type DefaultHarnessOptions,
} from './default-harness.js';
export {
  HarnessRegistryImpl,
  createHarnessRegistry,
} from './override.js';

// EXECUTE-stage helper exposed for tests / custom EXECUTE stages.
export { convertToolCall } from './stages/execute.js';

// LLM helpers (JSON extraction + retry-on-parse-failure). Reused by the CLI
// import-repo command and other LLM-backed utilities outside the harness loop.
export { callLlmForJson, extractJson } from './stages/_shared.js';

export {
  prepareModelRequest,
  recordModelRequest,
  recordProviderUsage,
  MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN,
  MAX_SNAPSHOT_MESSAGES,
  MAX_SNAPSHOT_ITEMS,
  MAX_SNAPSHOT_TOOLS,
} from './model-observability.js';
export { buildRunRequestCandidates, type BuildRunRequestCandidatesOptions } from './context-candidates.js';
export {
  LlmCallContractViolationError,
  normalizeLlmCallPurpose,
  resolveLlmCallContract,
  type LlmCallContractViolationReason,
  type ResolveLlmCallContractOptions,
} from './llm-call-contracts/registry.js';
export {
  collectConversationSourceRecords,
  conversationSourceRefs,
} from './conversation-source-records.js';
