// @littlesheep/types - internal v1 contracts for observable runtime continuity.

import type { StageName } from './agent.js';
import type { PlanStep, TaskBook, TaskExecutionResult } from './task.js';
import type { SessionId } from './session.js';
import type { ContextSafetyEstimate, LocalTokenLedger, ProviderTokenLedger } from './token-ledger.js';
import type { CacheObservation } from './cache-observability.js';
import type { NetworkReadPolicy, WebEvidenceProjection, WebProviderRuntimeSnapshot } from './web-retrieval.js';
export * from './token-ledger.js';

export const CONTEXT_SNAPSHOT_VERSION = 1 as const;
export const ATTACHMENT_MANIFEST_VERSION = 1 as const;
export const RUNTIME_EVENT_VERSION = 1 as const;
export const RUNTIME_EVENT_QUEUE_VERSION = 1 as const;
export const RUNTIME_CONTROL_VERSION = 1 as const;
export const TASK_BOOK_PATCH_VERSION = 1 as const;
export const RUN_CHECKPOINT_VERSION = 1 as const;
export const RUN_CHECKPOINT_DISPOSITION_VERSION = 1 as const;
export const RESOLVED_RUN_CONFIG_VERSION = 1 as const;
export const MODE_DEFINITION_VERSION = 1 as const;
export const MODEL_REQUEST_SNAPSHOT_VERSION = 1 as const;
export const LLM_CALL_CONTRACT_VERSION = 1 as const;
export const MEMORY_INTENT_DECISION_VERSION = 1 as const;
export const TOOL_INVOCATION_RECORD_VERSION = 1 as const;
export const EXECUTION_EVIDENCE_VERSION = 1 as const;
export const CONVERSATION_CONTINUATION_EVIDENCE_VERSION = 1 as const;

export type PermissionPolicyId = 'full' | 'research' | 'restricted';
export type ReasoningLevel = 'auto' | 'low' | 'medium' | 'high' | 'ultra';
export type RunConfigOrigin = 'app' | 'channel' | 'cli' | 'test';

/** Runtime-owned publication state when a durable final reply is unavailable. */
export interface RuntimeFinalStatus {
  readonly version: 1;
  readonly status: 'waiting_user' | 'failed' | 'interrupted';
  readonly reason?: string;
}

/** Redacted audit evidence for one authoritative conversation-turn decision. */
export interface ConversationContinuationEvidence {
  version: typeof CONVERSATION_CONTINUATION_EVIDENCE_VERSION;
  resolution: 'none' | 'eligible' | 'bound' | 'blocked' | 'conflict' | 'deferred' | 'abandoned';
  /** Stable, hashed identity shared by HTTP/SSE retries of the same turn. */
  turnId?: string;
  /** Digest used to reject reuse of the same key for different turn content. */
  inputDigest?: string;
  checkpointId?: string;
  candidateCheckpointIds?: string[];
  sourceRunId?: string;
  requestId?: string;
  answerMessageId?: string;
  resumeRunId?: string;
  disposition?: RunCheckpointContinuationDisposition;
  dispositionSource?: 'directive' | 'model' | 'runtime_fallback';
  resumeStage?: StageName;
  resumeRule?: string;
  resources?: {
    status: 'not_required' | 'restored' | 'failed' | 'skipped_for_disposition';
    attachmentCount: number;
    toolRecipeCount: number;
    restoredToolCount: number;
  };
  permissions?: {
    checkpoint: PermissionPolicyId;
    current: PermissionPolicyId;
  };
  replayPrevention?: {
    completedStepCountPreserved: number;
    succeededSideEffectCountPreserved: number;
    uncertainSideEffectCount: number;
    answerMessageAlreadyPersisted: boolean;
  };
  /** Present when the authoritative coordinator rejected the turn before execution. */
  failure?: {
    code:
      | 'multiple_waiting_heads'
      | 'checkpoint_not_resumable'
      | 'ambiguous_disposition'
      | 'resource_restore_failed'
      | 'required_tool_unavailable'
      | 'claim_conflict'
      | 'turn_identity_conflict'
      | 'continuation_runtime_error';
    detail: string;
    recoverable: boolean;
  };
}

/** Declarative behavior-mode contract. Permission is intentionally excluded. */
export interface ModeDefinition {
  readonly version: 1;
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly promptProfileId: string;
  readonly workflowStrategyId: string;
  readonly toolSelectionStrategyId: string;
  readonly memoryStrategyId: string;
  readonly contextStrategyId: string;
  readonly outputContractId: string;
  readonly modelDefaults: {
    readonly provider?: string;
    readonly model?: string;
    readonly reasoning?: ReasoningLevel;
    readonly parameters?: Readonly<Record<string, string | number | boolean | null>>;
  };
}

export interface ResolvedRunConfig {
  readonly version: 1;
  readonly runId: string;
  readonly resolvedAt: string;
  readonly origin: RunConfigOrigin;
  readonly behaviorModeId: string;
  readonly permissionPolicyId: PermissionPolicyId;
  readonly workflowStrategyId: string;
  readonly contextStrategyId: string;
  readonly memoryStrategyId: string;
  readonly toolSelectionStrategyId: string;
  readonly outputContractId: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
  readonly parameters: Readonly<Record<string, string | number | boolean | null>>;
  readonly availableToolNames: readonly string[];
  readonly approvalRequiredToolNames: readonly string[];
  /** Optional for legacy v1 records; all newly resolved runs populate this immutable policy. */
  readonly networkPolicy?: NetworkReadPolicy;
  /** Redacted provider state at run start. Credentials and endpoints are never retained here. */
  readonly webProvider?: WebProviderRuntimeSnapshot;
  readonly userOverrides: Readonly<Record<string, unknown>>;
  readonly projectOverrides: Readonly<Record<string, unknown>>;
  readonly sourceConfigRevision?: string;
}

export interface ModelMessageShape {
  role: 'system' | 'user' | 'assistant' | 'tool';
  contentKind: 'text' | 'multipart';
  characterCount: number;
  contentHash?: string;
  partTypes?: Array<'text' | 'image_url'>;
  toolCallCount: number;
  toolCallId?: string;
  toolName?: string;
  reasoningCharacterCount?: number;
  reasoningHash?: string;
}

export type LlmCallPurpose =
  | 'classify'
  | 'decide'
  | 'decide_explicit_tool'
  | 'execute_tool_loop'
  | 'execute_final_reply'
  | 'recover'
  | 'verify'
  | 'evolve'
  | 'capture'
  | 'reply'
  | 'capability_reply'
  | 'ask_user'
  | 'finalize'
  | 'session_compaction';

export type LlmMemoryIntentKind =
  | 'read'
  | 'write'
  | 'merge'
  | 'move'
  | 'revise'
  | 'invalidate'
  | 'conflict'
  | 'none';

export interface LlmCallInputContract {
  readonly sourcePolicy: 'explicit_candidates_only';
  readonly allowedContextKinds: readonly ContextItemKind[];
  readonly requiredContextKinds: readonly ContextItemKind[];
  readonly history: 'none' | 'recent' | 'session';
  readonly attachments: 'none' | 'manifest' | 'images_and_manifest';
}

export interface LlmCallOutputContract {
  readonly kind: 'json' | 'text' | 'none';
  readonly schemaId: string;
  readonly strict: boolean;
  readonly description: string;
}

export interface LlmCallMemoryIntentPolicy {
  readonly allowed: readonly LlmMemoryIntentKind[];
  readonly defaultIntent: 'none';
  readonly commitAuthority: 'runtime_only';
  readonly requiresEvidence: boolean;
  readonly writableBranches?: readonly string[];
}

export interface LlmCallToolPolicy {
  readonly mode: 'none' | 'registered' | 'step_scoped';
  readonly allowedToolNames: readonly string[];
  readonly runtimeApprovalRequired: boolean;
  readonly maxIterations: number;
}

export interface LlmCallBudgetContract {
  readonly maxAttempts: number;
  readonly maxOutputTokens: number;
  /** Stage-local prompt ceiling; smaller than the model window when possible. */
  readonly maxPromptTokens?: number;
  readonly temperature?: number;
  readonly contextCompressionThresholdRatio?: number;
}

/** Resolved, versioned policy for one model call or an explicitly forbidden call. */
export interface LlmCallContract {
  readonly version: 1;
  readonly id: string;
  readonly purpose: LlmCallPurpose;
  readonly stage: StageName;
  readonly modelCall: 'required' | 'optional' | 'forbidden';
  readonly goal: string;
  readonly inputs: LlmCallInputContract;
  readonly allowedDecisions: readonly string[];
  readonly outputSchema: LlmCallOutputContract;
  readonly memoryIntentPolicy: LlmCallMemoryIntentPolicy;
  readonly toolPolicy: LlmCallToolPolicy;
  readonly budget: LlmCallBudgetContract;
}

export interface ModelRequestSnapshot {
  version: 1;
  id: string;
  runId: string;
  sessionId: SessionId;
  stage: StageName;
  requestIndex: number;
  provider: string;
  model: string;
  createdAt: string;
  messages: ModelMessageShape[];
  totalMessageCount: number;
  messagesTruncated: boolean;
  toolNames: string[];
  totalToolCount: number;
  toolsTruncated: boolean;
  toolChoice?: 'auto' | 'none' | 'required' | string;
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  thinkingMode?: 'enabled' | 'disabled';
  preserveThinking?: boolean;
  stream: boolean;
  /** Present on new logs; omitted only for backward-compatible legacy snapshots. */
  callContract?: LlmCallContract;
  contextSnapshotId?: string;
  payloadHash?: string;
  /** Redacted, request-bound evidence for the three independent cache ledgers. */
  cacheObservation?: CacheObservation;
}

export type MemoryIntentRuntimeDecision = 'committed' | 'deferred' | 'rejected' | 'ignored';

/** Redacted audit record separating a model proposal from the runtime commit decision. */
export interface MemoryIntentDecisionRecord {
  readonly version: 1;
  readonly id: string;
  readonly runId: string;
  readonly stage: 'evolve' | 'capture';
  readonly proposedIntent: LlmMemoryIntentKind;
  readonly decision: MemoryIntentRuntimeDecision;
  readonly reason: string;
  readonly branch?: string;
  readonly summary?: string;
  readonly evidenceRefs: readonly string[];
  readonly writeIntentId?: string;
  readonly repositoryDecision?: 'created' | 'merged' | 'reinforced' | 'rejected' | 'queued';
  readonly reconciliationDecision?: 'committed' | 'partial' | 'noop' | 'rejected' | 'deferred';
  readonly createdAt: string;
}

export type ToolInvocationStatus =
  | 'proposed'
  | 'unknown_tool'
  | 'validation_failed'
  /** Runtime hard safety policy rejected the invocation; approval cannot override it. */
  | 'hard_denied'
  | 'approval_denied'
  | 'approval_unavailable'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'aborted'
  | 'repeated_call_blocked';

export interface ToolApprovalRecord {
  required: boolean | 'unknown';
  decision: 'not_required' | 'approved' | 'denied' | 'blocked' | 'unavailable' | 'error' | 'unknown';
  decidedAt?: string;
  reason?: string;
}

export interface ToolInvocationRecord {
  version: 1;
  id: string;
  callId: string;
  runId: string;
  sessionId: SessionId;
  stepId?: string;
  toolName: string;
  toolSource: string;
  status: ToolInvocationStatus;
  proposedAt: string;
  resolvedAt?: string;
  validatedAt?: string;
  startedAt?: string;
  endedAt?: string;
  inputHash?: string;
  inputSummary?: string;
  approval: ToolApprovalRecord;
  outputSummary?: string;
  outputSanitized?: boolean;
  outputTruncated?: boolean;
  errorKind?: string;
  error?: string;
  durationMs?: number;
  evidenceIds: string[];
}

export type ExecutionEvidenceKind =
  | 'context_snapshot'
  | 'model_request'
  | 'provider_usage'
  | 'tool_result'
  | 'approval'
  | 'file_state'
  | 'command_exit'
  | 'verification';

export interface ExecutionEvidence {
  version: 1;
  id: string;
  runId: string;
  sessionId: SessionId;
  stepId?: string;
  kind: ExecutionEvidenceKind;
  status: 'pass' | 'fail' | 'partial' | 'informational';
  sourceRef: string;
  summary: string;
  createdAt: string;
  contentHash?: string;
  sensitive: boolean;
  metadata: Record<string, unknown>;
}

export interface ExecutionEvidenceBundle {
  version: 1;
  runId: string;
  evidence: ExecutionEvidence[];
}

export type ContextScope = 'run' | 'session' | 'project' | 'workspace' | 'global';

export type ContextItemKind =
  | 'system_prompt'
  | 'user_input'
  | 'recent_message'
  | 'summary_memory'
  | 'memory_index'
  | 'memory_fragment'
  | 'project_knowledge'
  | 'tool_result'
  | 'workflow_state'
  | 'output_constraint'
  | 'attachment_manifest'
  | 'runtime_event';

export type ContextSourceKind =
  | 'prompt'
  | 'message'
  | 'memory'
  | 'tool'
  | 'workflow'
  | 'attachment'
  | 'runtime_event'
  | 'configuration';

export interface ContextSourceRef {
  kind: ContextSourceKind;
  id?: string;
  path?: string;
  runId?: string;
  sessionId?: SessionId;
  generatedAt?: string;
}

export interface ContextItem {
  id: string;
  kind: ContextItemKind;
  scope: ContextScope;
  source: ContextSourceRef;
  priority: number;
  required: boolean;
  sensitive: boolean;
  createdAt: string;
  contentType: 'text' | 'json' | 'image_ref' | 'file_ref';
  contentRef?: string;
  contentHash?: string;
  characterCount?: number;
}

export interface ContextSnapshotItem extends ContextItem {
  disposition: 'included' | 'omitted';
  omissionReason?: 'budget' | 'duplicate' | 'irrelevant' | 'unsafe' | 'unavailable';
  promptTokens?: number;
}

export interface KnownContextBudget {
  status: 'known';
  maxContextTokens: number;
  reservedOutputTokens: number;
  availablePromptTokens: number;
  compressionThresholdRatio: number;
}

export interface UnknownContextBudget {
  status: 'unknown';
  reason: string;
}

export type ContextBudget = KnownContextBudget | UnknownContextBudget;

export interface ContextSnapshot {
  version: 1;
  id: string;
  runId: string;
  sessionId: SessionId;
  provider: string;
  model: string;
  createdAt: string;
  budget: ContextBudget;
  items: ContextSnapshotItem[];
  totalItemCount: number;
  itemsTruncated: boolean;
  compressionRecommended: boolean;
  localTokenLedger?: LocalTokenLedger;
  safetyEstimate?: ContextSafetyEstimate;
  providerUsage?: ProviderTokenLedger;
}

export type AttachmentOwnership = 'cache' | 'agent_workplace' | 'user_workplace' | 'project' | 'external';
export type AttachmentContentState = 'uninspected' | 'indexed' | 'loaded' | 'unavailable' | 'rejected';

export interface AttachmentManifestEntry {
  id: string;
  name: string;
  kind: 'image' | 'document' | 'file';
  mimeType?: string;
  size?: number;
  path?: string;
  contentHash?: string;
  ownership: AttachmentOwnership;
  contentState: AttachmentContentState;
  registeredAt: string;
  loadedAt?: string;
  rejectionReason?: string;
}

export interface AttachmentManifest {
  version: 1;
  runId: string;
  entries: AttachmentManifestEntry[];
}

export type RuntimeEventType =
  | 'user_message'
  | 'pause_requested'
  | 'resume_requested'
  | 'interrupt_requested'
  | 'setting_changed'
  | 'workspace_file_saved';

export type RuntimeEventSource = 'app' | 'channel' | 'workspace' | 'system';
export type RuntimeEventStatus = 'queued' | 'applied' | 'ignored' | 'conflict' | 'expired';

export type RuntimeEventQueueRejectReason =
  | 'run-mismatch'
  | 'session-mismatch'
  | 'invalid-id'
  | 'invalid-dedup-key'
  | 'invalid-type'
  | 'invalid-source'
  | 'invalid-time'
  | 'invalid-payload'
  | 'payload-too-large'
  | 'capacity'
  | 'conflict'
  | 'sequence-exhausted'
  | 'disposed';

export interface RuntimeEventEnvelope {
  version: 1;
  id: string;
  runId: string;
  sessionId: SessionId;
  sequence: number;
  type: RuntimeEventType;
  source: RuntimeEventSource;
  status: RuntimeEventStatus;
  receivedAt: string;
  payload: Record<string, unknown>;
  dedupKey?: string;
  expiresAt?: string;
  appliedAt?: string;
  decisionReason?: string;
}

export interface RuntimeEventAppendInput {
  id?: string;
  runId?: string;
  sessionId?: SessionId;
  type: RuntimeEventType;
  source: RuntimeEventSource;
  payload: Record<string, unknown>;
  dedupKey?: string;
  receivedAt?: string;
  expiresAt?: string;
}

export type RuntimeEventAppendOutcome =
  | { kind: 'accepted'; event: RuntimeEventEnvelope }
  | { kind: 'duplicate'; event: RuntimeEventEnvelope }
  | { kind: 'expired'; event: RuntimeEventEnvelope }
  | {
      kind: 'rejected';
      reason: RuntimeEventQueueRejectReason;
      message: string;
      existingEventId?: string;
    };

export type RuntimeEventDecisionStatus = Exclude<RuntimeEventStatus, 'queued'>;

export interface RuntimeEventDecision {
  eventId: string;
  status: RuntimeEventDecisionStatus;
  reason?: string;
}

export interface RuntimeEventDecisionBatch {
  token: string;
  openedAt: string;
  cursor: number;
  events: RuntimeEventEnvelope[];
}

export interface RuntimeEventQueueSummary {
  runId: string;
  sessionId: SessionId;
  cursor: number;
  nextSequence: number;
  queued: number;
  applied: number;
  ignored: number;
  conflict: number;
  expired: number;
  pendingEventIds: string[];
  overflowCount: number;
  activeDecisionBatch: boolean;
}

/** Redacted event metadata suitable for diagnostics and context summaries. */
export interface RuntimeEventContextSummary {
  id: string;
  sequence: number;
  type: RuntimeEventType;
  source: RuntimeEventSource;
  status: RuntimeEventStatus;
  receivedAt: string;
  expiresAt?: string;
  payloadKeys: string[];
  decisionReasonRecorded: boolean;
}

/**
 * Public port consumed by Harness. The concrete queue remains owned by
 * Runner, so the dependency direction stays types -> no infrastructure.
 */
export interface RuntimeEventQueueLike {
  append(input: RuntimeEventAppendInput): RuntimeEventAppendOutcome;
  pending(limit?: number): RuntimeEventEnvelope[];
  openDecisionBatch(limit?: number): RuntimeEventDecisionBatch | undefined;
  openDecisionBatchForTypes(
    types: readonly RuntimeEventType[],
    limit?: number,
  ): RuntimeEventDecisionBatch | undefined;
  settleDecisionBatch(token: string, decisions: readonly RuntimeEventDecision[]): RuntimeEventEnvelope[];
  releaseDecisionBatch(token: string): boolean;
  snapshot(): RuntimeEventQueueSnapshot;
  summary(): RuntimeEventQueueSummary;
  contextSummary(limit?: number): RuntimeEventContextSummary[];
  dispose(): void;
}

export type RuntimeControlState = 'running' | 'paused' | 'interrupted';

export interface RuntimeControlSnapshot {
  version: typeof RUNTIME_CONTROL_VERSION;
  state: RuntimeControlState;
  changedAt: string;
  reason?: string;
  eventIds: string[];
}

export type RuntimeEventIngressRejectReason = 'run-not-active' | 'active-run-capacity';

export type RuntimeEventIngressOutcome =
  | RuntimeEventAppendOutcome
  | {
      kind: 'rejected';
      reason: RuntimeEventIngressRejectReason;
      message: string;
    };

/** Runner-owned ingress for events targeting an active run. */
export interface RuntimeEventIngress {
  append(
    runId: string,
    input: Omit<RuntimeEventAppendInput, 'runId'>,
  ): RuntimeEventIngressOutcome;
  summary(runId: string): RuntimeEventQueueSummary | null;
}

export type RuntimeActiveRunPhase = 'planning' | 'executing' | 'verifying' | 'finalizing';

export type RuntimeActiveRunControlStatus = 'running' | 'pause_requested' | 'interrupt_requested';

export type RuntimeActiveRunAction = 'pause' | 'resume' | 'interrupt';

export interface RuntimeActiveRunStep {
  stepId: string;
  title?: string;
}

/** Bounded, redacted state suitable for desktop and tray control surfaces. */
export interface RuntimeActiveRunSnapshot {
  runId: string;
  sessionId: SessionId;
  origin: RunConfigOrigin;
  startedAt: string;
  updatedAt: string;
  phase: RuntimeActiveRunPhase;
  controlStatus: RuntimeActiveRunControlStatus;
  totalSteps: number;
  completedSteps: number;
  activeSteps: RuntimeActiveRunStep[];
  activeToolCount: number;
}

export type RuntimeActiveRunActionOutcome =
  | {
      kind: 'accepted';
      action: RuntimeActiveRunAction;
      run: RuntimeActiveRunSnapshot;
    }
  | {
      kind: 'rejected';
      action: RuntimeActiveRunAction;
      reason: 'run-not-active' | 'action-conflict' | 'queue-rejected';
      message: string;
    };

/** Runtime-owned active-run query/control port; no Renderer state is authoritative. */
export interface RuntimeActiveRunControl {
  list(): RuntimeActiveRunSnapshot[];
  request(runId: string, action: RuntimeActiveRunAction, reason?: string): RuntimeActiveRunActionOutcome;
  subscribe(listener: (runs: RuntimeActiveRunSnapshot[]) => void): () => void;
}

/**
 * Bounded in-memory event queue state used by an active run. The queue is a
 * runtime continuity primitive; it is not an instruction stream for the LLM.
 * Event payloads remain available to the runtime for a controlled decision
 * boundary, while context assembly should use a redacted summary by default.
 */
export interface RuntimeEventQueueSnapshot {
  version: typeof RUNTIME_EVENT_QUEUE_VERSION;
  runId: string;
  sessionId: SessionId;
  cursor: number;
  nextSequence: number;
  overflowCount: number;
  events: RuntimeEventEnvelope[];
}

export type TaskBookPatchOperation =
  | { type: 'add_step'; afterStepId?: string; step: PlanStep }
  | { type: 'update_pending_step'; stepId: string; patch: Partial<Omit<PlanStep, 'id' | 'status'>> }
  | { type: 'remove_pending_step'; stepId: string }
  | { type: 'replace_success_criteria'; successCriteria: string[] }
  | { type: 'update_goal'; goal: string };

export interface TaskBookPatch {
  version: 1;
  id: string;
  runId: string;
  baseRevision: number;
  nextRevision: number;
  eventIds: string[];
  reason: string;
  operations: TaskBookPatchOperation[];
  createdAt: string;
}

export type SideEffectStatus = 'planned' | 'in_progress' | 'succeeded' | 'failed' | 'unknown';

export interface SideEffectCheckpoint {
  idempotencyKey: string;
  toolName: string;
  status: SideEffectStatus;
  /** Stable invocation identity used to avoid replaying an uncertain action. */
  inputHash?: string;
  /** The TaskBook step that owns this effect, when the run is step-aware. */
  stepId?: string;
  /** Provider/tool call id for evidence correlation; not used as the idempotency key. */
  callId?: string;
  /** Resource keys observed by the tool scheduler. */
  resourceKeys?: string[];
  effectKind?: 'local_mutation' | 'external' | 'unknown';
  startedAt?: string;
  endedAt?: string;
  evidenceRef?: string;
  error?: string;
}

export interface LoopBudgetSnapshot {
  attemptsUsed: number;
  maxAttempts: number;
  elapsedMs: number;
  maxElapsedMs: number;
  noProgressRounds: number;
  maxNoProgressRounds: number;
  costUsed?: number;
  maxCost?: number;
}

/** Minimal reference used to rebuild a run-scoped attachment. */
export interface RunCheckpointAttachmentReference {
  version: 1;
  attachmentId: string;
  cacheId: string;
  contentHash: string;
  name: string;
  kind: 'image' | 'document' | 'file';
  mimeType?: string;
  size?: number;
  /** Display-only source path for line-comment context; never used to restore content. */
  contextPath?: string;
  lineComments?: Array<{
    id?: string;
    startLine: number;
    endLine?: number;
    text: string;
  }>;
}

/** Trusted factory recipes are a closed enum; arbitrary code is never persisted. */
export interface RunCheckpointToolRecipe {
  version: 1;
  factory: 'inspect_attachment';
}

/** Structural clarification binding captured at the waiting-user boundary. */
export interface RunCheckpointContinuationState {
  version: 1;
  requestId: string;
  sourceStage: import('./clarification.js').ClarificationSourceStage;
}

/**
 * Resume metadata captured alongside a v1 checkpoint. It deliberately keeps
 * the original inbound message as a reference rather than duplicating its
 * full text. A resumed run gets a new run id and excludes that referenced
 * message from the newly assembled history, so the user message is never
 * appended twice.
 */
export interface RunCheckpointResumeState {
  version: 1;
  inboundMessageId: string;
  cwd: string;
  /** Workspace ownership must survive a continuation; cwd alone is not enough. */
  workspaceContext?: {
    boundaryKind: 'agent_workplace' | 'user_workplace' | 'project';
    projectId?: string;
  };
  model: string;
  origin: RunConfigOrigin;
  permissionPolicyId: PermissionPolicyId;
  reasoning: ReasoningLevel;
  behaviorModeId: string;
  availableToolNames: string[];
  attachmentCount: number;
  /** Present for checkpoints written after restorable resource support. */
  attachments?: RunCheckpointAttachmentReference[];
  /** Closed, versioned recipes for run-scoped tools. */
  toolRecipes?: RunCheckpointToolRecipe[];
  /** Pending structured request answered by the next bound user turn. */
  continuation?: RunCheckpointContinuationState;
  /** Bounded failure facts required to choose RECOVER without guessing. */
  lastError?: {
    stage: StageName;
    message: string;
  };
  classification?: import('./agent.js').Classification;
  needAssessment?: import('./task.js').NeedAssessment;
  plan?: PlanStep[];
  appliedTaskBookPatchIds: string[];
  deferredRuntimeEvents: RuntimeEventEnvelope[];
  recoveryAttempts: number;
  replanAttempts: number;
  maxReplanAttempts: number;
  verificationHistory: import('./task.js').VerificationRecord[];
}

export interface RunCheckpoint {
  version: 1;
  id: string;
  runId: string;
  sessionId: SessionId;
  status: 'paused' | 'waiting_user' | 'recoverable';
  currentStage: StageName;
  currentStepId?: string;
  /** Bounded parallel branches that were in progress at the checkpoint boundary. */
  activeStepIds?: string[];
  taskBook?: TaskBook;
  taskBookRevision: number;
  taskExecution?: TaskExecutionResult;
  eventCursor: number;
  pendingEventIds: string[];
  /** Full bounded queue state; omitted by legacy v1 checkpoint writers. */
  runtimeEventQueue?: RuntimeEventQueueSnapshot;
  /** Last deterministic pause/resume/interrupt state at the checkpoint boundary. */
  runtimeControl?: RuntimeControlSnapshot;
  contextSnapshotIds: string[];
  sideEffects: SideEffectCheckpoint[];
  loopBudget: LoopBudgetSnapshot;
  /** Optional bounded retrieval state. Old v1 checkpoints omit it and remain readable. */
  webEvidence?: WebEvidenceProjection;
  /** Optional in v1 for backward compatibility; old checkpoints are inspect-only. */
  resumeState?: RunCheckpointResumeState;
  createdAt: string;
  reason: string;
}

export type RunCheckpointDispositionStatus = 'resuming' | 'interrupted' | 'resumed' | 'completed' | 'abandoned' | 'deferred';
export type RunCheckpointContinuationDisposition = 'answer' | 'retry' | 'revise_goal' | 'cancel' | 'new_task';

/** Mutable, append-audited decision kept separate from immutable checkpoint data. */
export interface RunCheckpointDisposition {
  version: typeof RUN_CHECKPOINT_DISPOSITION_VERSION;
  checkpointId: string;
  status: RunCheckpointDispositionStatus;
  decidedAt: string;
  updatedAt: string;
  reason: string;
  resumeRunId?: string;
  /** Idempotency identity of the user answer that acquired the resume lease. */
  requestId?: string;
  answerMessageId?: string;
  requestKey?: string;
  /** Bounded semantic decision made after structural task binding. */
  continuationDisposition?: RunCheckpointContinuationDisposition;
  nextCheckpointId?: string;
  resultStatus?: 'ok' | 'error' | 'aborted';
  history: Array<{
    /** `interrupted` releases a resume lease left behind by a previous process. */
    status: RunCheckpointDispositionStatus;
    at: string;
    reason: string;
    resumeRunId?: string;
    requestId?: string;
    answerMessageId?: string;
    requestKey?: string;
    continuationDisposition?: RunCheckpointContinuationDisposition;
    nextCheckpointId?: string;
    resultStatus?: 'ok' | 'error' | 'aborted';
  }>;
}
