// @littlesheep/types - internal v1 contracts for observable runtime continuity.

import type {
  PlanStep,
  StageName,
  TaskBook,
  TaskExecutionResult,
} from './agent.js';
import type { SessionId } from './session.js';

export const CONTEXT_SNAPSHOT_VERSION = 1 as const;
export const ATTACHMENT_MANIFEST_VERSION = 1 as const;
export const RUNTIME_EVENT_VERSION = 1 as const;
export const TASK_BOOK_PATCH_VERSION = 1 as const;
export const RUN_CHECKPOINT_VERSION = 1 as const;
export const RESOLVED_RUN_CONFIG_VERSION = 1 as const;
export const MODE_DEFINITION_VERSION = 1 as const;
export const MODEL_REQUEST_SNAPSHOT_VERSION = 1 as const;
export const LLM_CALL_CONTRACT_VERSION = 1 as const;
export const MEMORY_INTENT_DECISION_VERSION = 1 as const;
export const TOOL_INVOCATION_RECORD_VERSION = 1 as const;
export const EXECUTION_EVIDENCE_VERSION = 1 as const;

export type PermissionPolicyId = 'full' | 'research' | 'restricted';
export type ReasoningLevel = 'auto' | 'low' | 'medium' | 'high' | 'ultra';
export type RunConfigOrigin = 'app' | 'channel' | 'cli' | 'test';

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
  | 'execute_tool_loop'
  | 'execute_final_reply'
  | 'recover'
  | 'verify'
  | 'evolve'
  | 'capture'
  | 'reply'
  | 'ask_user'
  | 'finalize'
  | 'session_compaction';

export type LlmMemoryIntentKind =
  | 'read'
  | 'write'
  | 'merge'
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
  readonly createdAt: string;
}

export type ToolInvocationStatus =
  | 'proposed'
  | 'unknown_tool'
  | 'validation_failed'
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
  decision: 'not_required' | 'approved' | 'denied' | 'unavailable' | 'error' | 'unknown';
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

export interface ExactLocalTokenLedger {
  version: 1;
  source: 'local';
  accuracy: 'exact';
  provider: string;
  model: string;
  tokenizerId: string;
  promptTokens: number;
  countedAt: string;
}

export interface UnavailableLocalTokenLedger {
  version: 1;
  source: 'local';
  accuracy: 'unavailable';
  provider: string;
  model: string;
  reason: string;
  countedAt: string;
}

export type LocalTokenLedger = ExactLocalTokenLedger | UnavailableLocalTokenLedger;

/** Internal overflow protection only. This estimate is never a displayable token ledger. */
export interface ContextSafetyEstimate {
  version: 1;
  source: 'local';
  accuracy: 'conservative';
  purpose: 'overflow_protection';
  provider: string;
  model: string;
  estimatorId: string;
  estimatedPromptTokens: number;
  calculatedAt: string;
  displayable: false;
}

export interface ProviderTokenLedger {
  version: 1;
  source: 'provider';
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
  cachedPromptTokens?: number;
  reasoningTokens?: number;
  requestId?: string;
  reportedAt: string;
}

export type TokenLedger = LocalTokenLedger | ProviderTokenLedger;

/** Returns a prompt-token value only when its source is explicitly trustworthy. */
export function getDisplayablePromptTokens(ledger: TokenLedger | undefined): number | undefined {
  if (!ledger) return undefined;
  if (ledger.source === 'provider') return ledger.promptTokens;
  return ledger.accuracy === 'exact' ? ledger.promptTokens : undefined;
}

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

export interface RunCheckpoint {
  version: 1;
  id: string;
  runId: string;
  sessionId: SessionId;
  status: 'paused' | 'waiting_user' | 'recoverable';
  currentStage: StageName;
  currentStepId?: string;
  taskBook?: TaskBook;
  taskBookRevision: number;
  taskExecution?: TaskExecutionResult;
  eventCursor: number;
  pendingEventIds: string[];
  contextSnapshotIds: string[];
  sideEffects: SideEffectCheckpoint[];
  loopBudget: LoopBudgetSnapshot;
  createdAt: string;
  reason: string;
}
