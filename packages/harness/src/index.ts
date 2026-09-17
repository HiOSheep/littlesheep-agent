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
  createHarnessStages,
  type DefaultHarnessOptions,
} from './default-harness.js';
export { createNextHarness } from './durable-harness.js';
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
  ensureModelRequestStarted,
  settleModelRequest,
  recordModelRequestFailure,
  flushModelRequestLifecycles,
  callModelChat,
  callModelChatStream,
  modelRequestIdFor,
  MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN,
  MAX_SNAPSHOT_MESSAGES,
  MAX_SNAPSHOT_ITEMS,
  MAX_SNAPSHOT_TOOLS,
} from './model-observability.js';
export {
  buildCacheObservation,
  buildCacheScopePartition,
  canonicalSerialize,
  classifyProviderCacheUsage,
  authorizeCacheObservationScope,
  assertCacheObservationScope,
  orderToolSpecs,
  type CacheObservationInput,
  type CacheScopeInput,
  type CacheScopeAccessDecision,
  type ValidProviderUsage,
} from './cache-observability.js';
export {
  CacheObservationStore,
  type CacheObservationLookupInput,
  type CacheObservationLookupResult,
  type CacheObservationStoreOptions,
  type CacheObservationStoreResult,
} from './cache-observation-store.js';
export { buildRunRequestCandidates, type BuildRunRequestCandidatesOptions } from './context-candidates.js';
export {
  buildCacheQualityReport,
  type CacheQualityReport,
  type CacheTokenUsageSummary,
  type CacheVerificationSummary,
  type CacheRequestOutcomeSummary,
  type CacheLedgerSummary,
} from './cache-quality-report.js';
export {
  compareHarnessPaths,
  type HarnessPathComparison,
  type HarnessPathLabel,
  type HarnessPathSummary,
} from './harness-path-comparison.js';
export { capabilityProbeEvent } from './capability-events.js';
export {
  canUseLeanWorkLoop,
  isSupportedWorkPolicy,
  resolveExecutionWorkPolicy,
  selectWorkPolicy,
} from './lean-work-policy.js';
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
export { resolveMemoryWriteEpistemic } from './stages/memory-epistemic-policy.js';
export {
  consumeRuntimeControlEvents,
  RUNTIME_CONTROL_EVENT_TYPES,
  type RuntimeControlBoundaryResult,
} from './runtime-control-boundary.js';
export { writeReplanState, type ReplanStateUpdate } from './replan-state.js';
export { clearReplyState, writeReplyState, type ReplyStateUpdate } from './reply-state.js';
export { finalReplyFingerprint, finalReplySettlementId } from './final-reply-identity.js';
export { settleDeferredFinalReply } from './stages/finalize.js';
export { writeRuntimeState, type RuntimeStateUpdate } from './runtime-state.js';
export { writeCapabilityState, type CapabilityStateUpdate } from './capability-state.js';
export { writeMemoryState, type MemoryStateUpdate } from './memory-state.js';
export {
  writeDecisionState,
  updateClarificationRequest,
  type DecisionStateUpdate,
} from './decision-state.js';
export {
  writeFailureState,
  recordFailure,
  clearFailure,
  incrementRecoveryAttempts,
  type FailureStateUpdate,
} from './failure-state.js';
export {
  writeExecutionEvidenceState,
  replaceToolResults,
  upsertToolInvocationEvidence,
  replaceSideEffectEvidence,
  type ExecutionEvidenceStateUpdate,
} from './execution-evidence-state.js';
export {
  writeModelObservabilityState,
  incrementModelCallCount,
  appendModelObservations,
  updateContextSnapshot,
  type ModelObservabilityStateUpdate,
} from './model-observability-state.js';
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

export {
  DurableHarnessKernel,
  DurableKernelError,
  reduceDurableRunProjection,
  replayDurableFinalReply,
  type DurableHarnessKernelOptions,
  type DurableRecoveryOptions,
} from './durable-kernel.js';
export type { DurableInboxProcessResult } from './durable-inbox-processor.js';
