// @littlesheep/runner — public API
//
// Shared agent runner used by:
//   - Electron APP (local conversations, origin='app')
//   - Optional channel plugins (channel-routed conversations, origin='channel')
//   - CLI (single-shot + REPL, origin='cli')
//
// The runner is the core execution entry point; optional extensions call it
// through their declared contribution contracts.

export {
  createRunner,
  type AgentRunner,
  type RunnerResult,
  type CreateRunnerOptions,
  type RunInput,
  type RunOrigin,
  type ResumeCheckpointOptions,
} from './runner.js';

export { resolveRunConfig, type ResolveRunConfigOptions } from './run-config.js';

export {
  buildInfrastructure,
  resolveLlm,
  type Infrastructure,
  type RunnerState,
  type BuildInfrastructureOptions,
  type LogFn,
} from './infra.js';

export {
  ExecutionLogStore,
  type ExecutionLog,
  type ExecutionLogInput,
  type ToolCallRecord,
  type StageTraceEntry,
  type ExecutionLogStoreOptions,
} from './execution-log.js';

export {
  MEMORY_WORKLOAD_OBSERVATION_VERSION,
  observeMemoryWorkload,
  type MemoryWorkloadObservation,
  type MemoryWorkloadObservationOptions,
} from './memory-workload-observability.js';

export {
  RUNTIME_RESOURCE_OBSERVATION_VERSION,
  beginRuntimeResourceObservation,
  completeRuntimeResourceObservation,
  type RuntimeDeviceClass,
  type RuntimeResourceObservation,
  type RuntimeResourceObservationStart,
  type RuntimeResourceSample,
} from './runtime-resource-observation.js';

export {
  ActiveRunRegistry,
  DEFAULT_MAX_ACTIVE_RUNTIME_RUNS,
  MAX_ACTIVE_RUNTIME_RUNS,
  type ActiveRunRegistryOptions,
} from './active-run-registry.js';

export {
  RunCheckpointStore,
  RunCheckpointStoreDisposedError,
  RunCheckpointValidationError,
  DEFAULT_RUN_CHECKPOINT_MAX_FILE_BYTES,
  DEFAULT_RUN_CHECKPOINT_MAX_HISTORY,
  DEFAULT_RUN_CHECKPOINT_MAX_PER_RUN,
  DEFAULT_RUN_CHECKPOINT_MAX_READ_ENTRIES,
  MAX_RUN_CHECKPOINT_MAX_FILE_BYTES,
  MAX_RUN_CHECKPOINT_MAX_HISTORY,
  MAX_RUN_CHECKPOINT_MAX_PER_RUN,
  MAX_RUN_CHECKPOINT_MAX_READ_ENTRIES,
  type RunCheckpointDiagnostic,
  type RunCheckpointStoreDiagnostics,
  type RunCheckpointStoreOptions,
  type RunCheckpointWriteOutcome,
} from './run-checkpoint-store.js';

export {
  buildRunCheckpoint,
  shouldPersistRunCheckpoint,
  type BuildRunCheckpointOptions,
} from './run-checkpoint.js';

export {
  RunCheckpointController,
  DEFAULT_CHECKPOINT_INSPECTION_LIMIT,
  MAX_CHECKPOINT_INSPECTION_LIMIT,
  type RunCheckpointClaimOutcome,
  type RunCheckpointControllerOptions,
  type RunCheckpointInspection,
} from './run-checkpoint-controller.js';

export {
  RunCheckpointDispositionStore,
  DEFAULT_RUN_CHECKPOINT_DISPOSITION_MAX_RECORDS,
  MAX_RUN_CHECKPOINT_DISPOSITION_MAX_RECORDS,
  type RunCheckpointDispositionOutcome,
  type RunCheckpointDispositionStoreOptions,
} from './run-checkpoint-disposition-store.js';

export {
  DEFAULT_RUNTIME_EVENT_BATCH_LEASE_MS,
  DEFAULT_RUNTIME_EVENT_BATCH_SIZE,
  DEFAULT_RUNTIME_EVENT_MAX_AGE_MS,
  DEFAULT_RUNTIME_EVENT_QUEUE_MAX_EVENTS,
  DEFAULT_RUNTIME_EVENT_QUEUE_MAX_PAYLOAD_BYTES,
  MAX_RUNTIME_EVENT_BATCH_LEASE_MS,
  MAX_RUNTIME_EVENT_BATCH_SIZE,
  MAX_RUNTIME_EVENT_MAX_AGE_MS,
  MAX_RUNTIME_EVENT_QUEUE_MAX_EVENTS,
  MAX_RUNTIME_EVENT_QUEUE_MAX_PAYLOAD_BYTES,
  RuntimeEventQueue,
  RuntimeEventQueueBusyError,
  RuntimeEventQueueSnapshotError,
  type RuntimeEventAppendInput,
  type RuntimeEventAppendOutcome,
  type RuntimeEventContextSummary,
  type RuntimeEventDecision,
  type RuntimeEventDecisionBatch,
  type RuntimeEventQueueOptions,
  type RuntimeEventQueueRejectReason,
  type RuntimeEventQueueSummary,
  type RuntimeEventDecisionStatus,
} from './runtime-event-queue.js';
