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
  assessResponseMemoryContinuity,
  type ResponseContinuityInput,
} from './response-continuity.js';
export {
  continuityLabeledValues,
  type ContinuityLabeledValue,
} from './response-continuity-text.js';
export {
  readSessionSummaryFidelityFields,
  SESSION_SUMMARY_FIDELITY_END,
  SESSION_SUMMARY_FIDELITY_START,
  stripSessionSummaryFidelitySections,
  type SessionSummaryFidelityField,
} from './session-summary-fidelity-text.js';
export {
  acceptUniqueUserFacingReply,
  collectRecentAssistantReplies,
  normalizeUserFacingReply,
  UserFacingReplyError,
  MAX_RECENT_VISIBLE_REPLIES,
  MAX_VISIBLE_REPLY_REWRITES,
} from './user-facing-reply.js';
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
export {
  consumeRuntimeControlEvents,
  RUNTIME_CONTROL_EVENT_TYPES,
  type RuntimeControlBoundaryResult,
} from './runtime-control-boundary.js';
export { writeReplanState, type ReplanStateUpdate } from './replan-state.js';
export { clearReplyState, writeReplyState, type ReplyStateUpdate } from './reply-state.js';
export { writeRuntimeState, type RuntimeStateUpdate } from './runtime-state.js';
export { writeMemoryState, type MemoryStateUpdate } from './memory-state.js';
export {
  writeUsageState,
  writeProviderUsageState,
  type UsageStateUpdate,
} from './usage-state.js';
export {
  applyTaskBookPatch,
  applyTaskBookPatchToContext,
  MAX_APPLIED_TASK_BOOK_PATCH_IDS,
  MAX_TASK_BOOK_PATCH_CRITERIA,
  MAX_TASK_BOOK_PATCH_EVENT_IDS,
  MAX_TASK_BOOK_PATCH_OPERATIONS,
  MAX_TASK_BOOK_PATCH_STEPS,
  MAX_TASK_BOOK_PATCH_TEXT,
  MAX_TASK_BOOK_PATCH_TOOLS,
  type TaskBookPatchApplyOptions,
  type TaskBookPatchApplyResult,
  type TaskBookPatchRejectReason,
} from './taskbook-patch.js';
