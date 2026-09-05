// @littlesheep/types — agent.ts
// Core Flow state machine types: stages, harness, hooks, run lifecycle.
//
// This is the heart of LittleSheep. Runtime owns hard control-flow boundaries;
// the model may choose a bounded semantic activity, but cannot invent tools,
// permissions, or transitions outside the runtime contract.

import type { FinalReplyReservation, FinalReplySettlement, Message, ReplyProvenance } from './message.js';
import type { CompactionSummary, SessionId, SessionRunSummary } from './session.js';
import type { AgentTool, ToolContext } from './tool.js';
import type { MemoryPrelude } from './memory.js';
import type { ClarificationRequest, ClarificationResponse } from './clarification.js';
import type {
  NeedAssessment,
  PartialReplanRequest,
  PlanStep,
  TaskBook,
  TaskExecutionResult,
  TaskReplanRecord,
  TaskStepStatus,
  VerificationRecord,
} from './task.js';

// ─── Stage names (state machine nodes) ──────────────────────────────────

/** All possible state machine nodes in the Core Flow. */
export type StageName =
  | 'enter'
  | 'classify'
  | 'reply'
  | 'ask_user'
  | 'decide'
  | 'execute'
  | 'recover'
  | 'verify'
  | 'evolve'
  | 'capture'
  | 'finalize';

/** The compact semantic activity route selected for an inbound message. */
export type AgentActivity = 'respond' | 'execute' | 'clarify';

/** Legacy persisted classifier labels kept for old sessions and plugins. */
export type MessageClass = 'chat' | 'problem' | 'unclear';

export type RetrievalIntent =
  | 'none'
  | 'capability_question'
  | 'capability_probe'
  | 'local_workspace'
  | 'local_memory'
  | 'web_search'
  | 'web_fetch'
  | 'combined_memory_web'
  | 'browser_required';

export function activityFromMessageClass(value: MessageClass | undefined): AgentActivity {
  if (value === 'problem') return 'execute';
  if (value === 'unclear') return 'clarify';
  return 'respond';
}

export function messageClassFromActivity(value: AgentActivity): MessageClass {
  if (value === 'execute') return 'problem';
  if (value === 'clarify') return 'unclear';
  return 'chat';
}

export interface Classification {
  /** New semantic route used by the runtime. */
  activity?: AgentActivity;
  /** Legacy route label accepted while old checkpoints and plugins drain. */
  type?: MessageClass;
  /** 0..1 confidence. Below threshold → LLM fallback. */
  confidence: number;
  /** Which classifier produced this ('rules' | 'llm'). */
  source: 'rules' | 'llm';
  /** Optional reason for debugging. */
  reason?: string;
  /** Runtime-owned retrieval boundary inferred only from the inbound user message. */
  retrievalIntent?: RetrievalIntent;
}

/** A recovery decision from RECOVER. */
export type RecoveryDecision =
  | { action: 'retry'; revisedPlan?: PlanStep[]; note?: string }
  | { action: 'escalate'; reason: string }
  | { action: 'abort'; reason: string };

export interface RuntimeMemoryContextWorkingSet {
  revision: number;
  activeAtomIds: string[];
  releasedAtomIds: string[];
  activeCallByAtom: Record<string, string>;
  callAtomIds: Record<string, string[]>;
  updatedAt: string;
}

// ─── Run context (threaded through all stages) ───────────────────────────

/** The shared context object passed stage-to-stage. Stages mutate this. */
export interface RunContext {
  /** Unique run id. */
  runId: string;
  /** Session this run belongs to. */
  sessionId: SessionId;
  /** The raw inbound user message that started this run. */
  inbound: Message;
  /** Working directory. */
  cwd: string;
  /** Resolved workspace ownership boundary used by memory/resource registration. */
  workspaceContext?: {
    boundaryKind: 'agent_workplace' | 'user_workplace' | 'project';
    projectId?: string;
  };
  /** Model ref (provider/model). */
  model: string;
  /** Tools available to EXECUTE stage. */
  tools: AgentTool[];
  toolSources?: Record<string, string>;
  /** Tool execution context (cwd, approve, signal, log). */
  toolContext: ToolContext;
  /** Bounded authoritative lifecycle records produced by ToolExecutionService. */
  toolInvocations?: import('./runtime-contracts.js').ToolInvocationRecord[];
  toolInvocationsTruncated?: boolean;
  /** Memory prelude injected at ENTER. */
  prelude?: MemoryPrelude;
  /** Versioned non-destructive summary of older messages in this session. */
  sessionSummary?: CompactionSummary;
  /** Bounded execution facts from the preceding run for immediate follow-up questions. */
  previousRun?: SessionRunSummary;
  /** Stable root index for the on-demand runtime memory tree. */
  memoryRootIndex?: string;
  /** Small D2 atom set selected through D1 indexes before the first model decision. */
  initialMemoryContext?: string;
  /** Prompt-resident bootstrap contents (AGENTS/SOUL/USER/TOOLS only). */
  bootstrap?: Record<string, string>;
  /** Session transcript (loaded messages). */
  history: Message[];
  /** Messages produced during this run (to be persisted). */
  produced: Message[];
  /** Classification result (set by CLASSIFY). */
  classification?: Classification;
  /** Demand calibration from DECIDE. */
  needAssessment?: NeedAssessment;
  /** Structured task book from DECIDE. */
  taskBook?: TaskBook;
  /** Monotonic revision of the run-local TaskBook; starts at 1 when present. */
  taskBookRevision?: number;
  /** Bounded ids of TaskBook patches already committed at a runtime boundary. */
  appliedTaskBookPatchIds?: string[];
  /** Runtime events retained for a later re-plan instead of being silently lost. */
  deferredRuntimeEventIds?: string[];
  /** Bounded event envelopes supplied to the next DECIDE pass for re-planning. */
  deferredRuntimeEvents?: import('./runtime-contracts.js').RuntimeEventEnvelope[];
  /** Bounded side-effect ledger supplied by host-owned tool execution. */
  sideEffects?: import('./runtime-contracts.js').SideEffectCheckpoint[];
  /** Bounded loop budget snapshot used by recovery/checkpoint diagnostics. */
  loopBudget?: import('./runtime-contracts.js').LoopBudgetSnapshot;
  /** Runtime execution result for the current task book. */
  taskExecution?: TaskExecutionResult;
  /** Plan from DECIDE. */
  plan?: PlanStep[];
  /** Tool results from EXECUTE. */
  toolResults?: import('./message.js').ToolResult[];
  /** Bounded network retrieval evidence accumulated by Runtime-owned tools. */
  webEvidence?: import('./web-retrieval.js').WebEvidenceProjection;
  /** Recovery attempt count (incremented in RECOVER). */
  recoveryAttempts?: number;
  /** Max recovery attempts before escalation. */
  maxRecoveryAttempts: number;
  /** Replan count (incremented when VERIFY returns needs_replan). */
  replanAttempts?: number;
  /** Replan upper bound; VERIFY force-passes when exhausted. Default 2. */
  maxReplanAttempts?: number;
  /** Feedback from VERIFY → DECIDE on a needs_replan. Cleared by DECIDE. */
  verifyFeedback?: string;
  /** Step-scoped re-plan request created by VERIFY and consumed by DECIDE/EXECUTE. */
  partialReplanRequest?: PartialReplanRequest;
  /** Audit trail retained across repeated DECIDE/EXECUTE passes. */
  replanHistory?: TaskReplanRecord[];
  /** Every VERIFY decision made during this run. */
  verificationHistory?: VerificationRecord[];
  /** Structured request when this run intentionally pauses for user input. */
  clarificationRequest?: ClarificationRequest;
  /** Previous clarification answered by the inbound message, when present. */
  clarificationResponse?: ClarificationResponse;
  /** Last error that triggered RECOVER. */
  lastError?: { stage: StageName; message: string; cause?: unknown };
  /** EVOLVE notes. */
  evolutionNotes?: string[];
  /** CAPTURE insights. */
  insights?: string[];
  /** Runtime decisions for model-proposed memory operations. */
  memoryIntentDecisions?: import('./runtime-contracts.js').MemoryIntentDecisionRecord[];
  /** Run-owned bounded event queue; payloads are only opened at safe boundaries. */
  runtimeEventQueue?: import('./runtime-contracts.js').RuntimeEventQueueLike;
  /** Ordered, durable next-Harness event sink. Runtime owns persistence. */
  appendDurableEvent?: (
    event: Omit<import('./durable-harness.js').DurableHarnessEventAppendInput, 'sessionId' | 'runId'>,
  ) => Promise<void>;
  /** Start the harness at a recovered stage instead of always entering fresh. */
  entryStage?: StageName;
  /** Original checkpoint identity when this context is a continuation run. */
  resumedFromCheckpointId?: string;
  /** Redacted structural evidence for the authoritative conversation-turn decision. */
  conversationContinuation?: import('./runtime-contracts.js').ConversationContinuationEvidence;
  /** Persist a bounded runtime checkpoint before/after an effectful tool call. */
  persistRuntimeCheckpoint?: (reason: string) => Promise<string | undefined>;
  /** Deterministic control state applied by the Harness at a safe boundary. */
  runtimeControl?: import('./runtime-contracts.js').RuntimeControlSnapshot;
  /** Versioned run-local evidence adopted, excluded or conflicted by Memory v3. */
  memoryKnownState?: import('./memory-evidence.js').RuntimeMemoryKnownState;
  /** Local evidence assessment of continuity between memory and the final reply. */
  memoryContinuityAssessment?: import('./memory-continuity.js').MemoryContinuityAssessment;
  /** Run-scoped atom ownership used to add, release, and re-add memory context safely. */
  memoryContextWorkingSet?: RuntimeMemoryContextWorkingSet;
  /** Final reply text. */
  reply?: string;
  /** LLM provenance for the final user-visible reply. */
  replyProvenance?: ReplyProvenance;
  /** Atomically reserves a never-published reply in the durable session registry. */
  reserveUserFacingReply?: (reply: string) => Promise<boolean>;
  /** Reserves one candidate with the same identity used by FINALIZE/durable log. */
  reserveUserFacingReplySettlement?: (reservation: FinalReplyReservation) => Promise<boolean>;
  /** Commits the registry reservation after the session message is durable. */
  settleUserFacingReplySettlement?: (reservation: FinalReplyReservation) => Promise<void>;
  /**
   * Next-Harness publication gate: FINALIZE may leave the reservation in the
   * proposed state until Runner-owned audit persistence has completed.
   */
  deferFinalReplySettlement?: boolean;
  /** Reservation held by FINALIZE while the Runner completes the publication gate. */
  pendingFinalReplySettlement?: FinalReplyReservation;
  /** Registry commit completed before a durable-event append failed. */
  finalReplyRegistrySettled?: boolean;
  /** Durable final-reply event was appended before a registry commit failed. */
  finalReplyEventSettled?: boolean;
  /** The durable event append outcome is uncertain and needs recovery. */
  finalReplySettlementUncertain?: boolean;
  /** Authoritative final-reply identity carried through FINALIZE and replay. */
  finalReplySettlement?: FinalReplySettlement;
  /** Token usage reported by the model provider for the reply-bearing call. */
  usage?: RunUsage;
  /** Immutable per-run configuration resolved before the harness starts. */
  resolvedRunConfig?: import('./runtime-contracts.js').ResolvedRunConfig;
  /** Bounded, redacted snapshots of actual model requests made by this run. */
  modelRequests?: import('./runtime-contracts.js').ModelRequestSnapshot[];
  /** Hard upper bound for provider calls in one run. */
  maxModelCalls?: number;
  /** Monotonic provider-call count; independent from bounded observability arrays. */
  modelCallCount?: number;
  /** Bounded, redacted context snapshots linked from model request snapshots. */
  contextSnapshots?: import('./runtime-contracts.js').ContextSnapshot[];
  /** Runtime-only HMAC key for cache observations; never persisted in checkpoints or logs. */
  cacheObservationKey?: string | null;
  /** Non-blocking persistence hook for redacted cache observations. */
  persistCacheObservation?: (
    observation: import('./cache-observability.js').CacheObservation,
  ) => Promise<void>;
  /** Versioned Runtime capability facts used for truthful capability answers. */
  capabilitySnapshot?: import('./capability.js').RuntimeCapabilitySnapshot;
  /** Durable probe evidence, present only after a real capability probe. */
  capabilityProbe?: import('./capability.js').RuntimeCapabilityProbe;
  /** Permission decision paired with the capability probe/snapshot. */
  capabilityPermissionEvent?: import('./capability.js').RuntimePermissionEvent;
  /** Configured request occupancy ratio that recommends context compaction. */
  contextCompressionThresholdRatio?: number;
  /** Optional streaming callback for assistant text deltas. */
  onAssistantDelta?: (delta: string) => void;
  /** Replace the provisional streamed text with the approved final reply. */
  onAssistantReplace?: (text: string) => void;
  /** Optional callback for tool execution events (start/end), emitted by execute stage. */
  onToolEvent?: (evt: ToolStreamEvent) => void;
  /** System prompt injected by the active general/coding behavior profile. */
  profilePromptAddon?: string;
  /** Prompt guidance for the selected reasoning budget; unrelated to permissions. */
  reasoningPromptAddon?: string;
  /** Attachments available to this run. Binary payloads are not persisted. */
  attachments?: RunAttachment[];
  /** Run metadata for diagnostics. */
  startedAt: string;
  /** User-configured or host-resolved IANA time zone. */
  timeZone?: string;
  /** User-facing clock preference; exact runtime state always retains seconds. */
  timeFormat?: 'auto' | '12' | '24';
  /** Injectable runtime clock used by deterministic tests. */
  runtimeNow?: () => Date;
  /** Abort signal. */
  signal?: AbortSignal;
}

export interface RunUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
  source: 'provider';
}

export interface RunAttachment {
  id?: string;
  path: string;
  /** User-facing source path; `path` may point at the managed cache copy. */
  contextPath?: string;
  name?: string;
  kind: 'image' | 'document' | 'file';
  mimeType?: string;
  size?: number;
  /** Stable identity inside the LS-managed attachment cache. */
  cacheId?: string;
  /** Stable digest for a verified LS-managed cache entry. */
  contentHash?: string;
  /** Data URL for image inputs when the selected model supports vision. */
  dataUrl?: string;
  /** Ephemeral extracted content. It is never persisted in AgentResult or execution logs. */
  extractedText?: string;
  extractionNote?: string;
  ownership?: import('./runtime-contracts.js').AttachmentOwnership;
  contentState?: import('./runtime-contracts.js').AttachmentContentState;
  /** User-authored line comments attached to a source file for this run. */
  lineComments?: Array<{
    id?: string;
    startLine: number;
    endLine?: number;
    text: string;
  }>;
}

// ─── Stage contract ──────────────────────────────────────────────────────

/** Result of executing a single stage. */
export interface StageResult {
  /** Which stage just ran. */
  stage: StageName;
  /** Next stage to transition to. The harness honors this for flow control. */
  next: StageName | 'exit';
  /** Whether the stage succeeded. */
  ok: boolean;
  /** Error text if ok === false. */
  error?: string;
  /** Diagnostics (timing, tool calls made, tokens used). */
  meta?: Record<string, unknown>;
}

/** A stage is an async function from RunContext → StageResult. */
export type Stage = (ctx: RunContext) => Promise<StageResult>;

// ─── Hook system (three execution models) ─────────────────────────

/** Hook execution model. */
export type HookKind = 'void' | 'modifying' | 'claiming';

/** Void hook: observe only, no mutation. */
export interface VoidHook {
  kind: 'void';
  /** Higher priority runs first. */
  priority?: number;
  /** Stage this hook attaches to (or '*' for all). */
  stage: StageName | '*';
  /** When relative to the stage. */
  phase: 'before' | 'after';
  run(ctx: RunContext): Promise<void>;
}

/** Modifying hook: may mutate ctx or the stage result. */
export interface ModifyingHook {
  kind: 'modifying';
  priority?: number;
  stage: StageName | '*';
  phase: 'before' | 'after';
  run(ctx: RunContext, result?: StageResult): Promise<StageResult | void>;
}

/** Claiming hook: can replace the stage entirely (Layer 2 equivalent). */
export interface ClaimingHook {
  kind: 'claiming';
  priority?: number;
  stage: StageName;
  /** If this returns a StageResult, the default stage is skipped. */
  claim(ctx: RunContext): Promise<StageResult | null>;
}

export type AnyHook = VoidHook | ModifyingHook | ClaimingHook;

/** Hook failure policy. */
export type HookFailurePolicy = 'continue' | 'abort';

// ─── Agent harness (the state machine driver) ────────────────────────────

/** The harness contract. Drives stages + hooks. */
export interface AgentHarness {
  /** Unique harness name. */
  name: string;
  /** Run the full state machine for one inbound message. */
  run(ctx: RunContext): Promise<StageResult>;
  /** Register a hook (Layer 3). */
  on(hook: AnyHook): void;
  /** Replace a stage (Layer 2). */
  registerStage(name: StageName, stage: Stage): void;
}

/** Registry for harnesses (Layer 1: full replacement). */
export interface HarnessRegistry {
  register(name: string, harness: AgentHarness): void;
  get(name: string): AgentHarness | undefined;
  /** Default harness (Core Flow). */
  default: AgentHarness;
}

// ─── Run lifecycle ───────────────────────────────────────────────────────

/** Status of an agent run. */
export type RunStatus = 'queued' | 'running' | 'ok' | 'error' | 'timeout' | 'aborted';

/** A run record (persisted + streamed). */
export interface AgentRun {
  runId: string;
  sessionId: SessionId;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  /** Stages traversed (in order). */
  stages: { name: StageName; startedAt: string; endedAt: string; ok: boolean }[];
  /** Final reply text (when status === 'ok'). */
  reply?: string;
  /** LLM provenance for the final user-visible reply. */
  replyProvenance?: ReplyProvenance;
  finalReplySettlement?: FinalReplySettlement;
  /** Error text (when status === 'error'). */
  error?: string;
}

/** Final result of a run. */
export interface AgentResult {
  runId: string;
  status: RunStatus;
  reply?: string;
  /** LLM provenance for the final user-visible reply. */
  replyProvenance?: ReplyProvenance;
  /** Authoritative final reply settlement; streams are only provisional views. */
  finalReplySettlement?: FinalReplySettlement;
  /** Runtime-owned status used when the next Harness cannot publish a reply. */
  runtimeStatus?: import('./runtime-contracts.js').RuntimeFinalStatus;
  error?: string;
  /** Messages to persist. */
  messages: Message[];
  /** Stage trace. */
  trace: AgentRun['stages'];
  /** Duration in ms. */
  durationMs: number;
  /** Token usage for the reply-bearing model call when the provider reports it. */
  usage?: RunUsage;
  /** Immutable configuration used for this run. */
  resolvedRunConfig?: import('./runtime-contracts.js').ResolvedRunConfig;
  /** Runtime-owned capability facts and epoch used by this run. */
  capabilitySnapshot?: import('./capability.js').RuntimeCapabilitySnapshot;
  capabilityProbe?: import('./capability.js').RuntimeCapabilityProbe;
  capabilityPermissionEvent?: import('./capability.js').RuntimePermissionEvent;
  /** Bounded, redacted request observations. */
  modelRequests?: import('./runtime-contracts.js').ModelRequestSnapshot[];
  /** Bounded, redacted context observations. */
  contextSnapshots?: import('./runtime-contracts.js').ContextSnapshot[];
  /** Structured task execution result when DECIDE produced a task book. */
  taskExecution?: TaskExecutionResult;
  /** Bounded authoritative tool lifecycle records for this run. */
  toolInvocations?: import('./runtime-contracts.js').ToolInvocationRecord[];
  /** Bounded network retrieval evidence; never contains fetched page bodies or raw queries. */
  webEvidence?: import('./web-retrieval.js').WebEvidenceProjection;
  /** True when additional invocation records were intentionally not retained. */
  toolInvocationsTruncated?: boolean;
  /** Bounded side-effect checkpoint ledger used by recovery and external verification. */
  sideEffects?: import('./runtime-contracts.js').SideEffectCheckpoint[];
  /** Calibrated task contract used by EXECUTE/VERIFY. */
  taskBook?: TaskBook;
  /** Durable VERIFY decisions associated with this result. */
  verificationHistory?: VerificationRecord[];
  /** Last deterministic runtime control state applied at a safe boundary. */
  runtimeControl?: import('./runtime-contracts.js').RuntimeControlSnapshot;
  /** Bounded event queue snapshot captured before active-run cleanup. */
  runtimeEventQueue?: import('./runtime-contracts.js').RuntimeEventQueueSnapshot;
  /** Redacted model-proposal versus runtime-commit memory audit. */
  memoryIntentDecisions?: import('./runtime-contracts.js').MemoryIntentDecisionRecord[];
  /** Bounded Memory v3 evidence state used across DECIDE/EXECUTE/VERIFY/FINALIZE. */
  memoryKnownState?: import('./memory-evidence.js').RuntimeMemoryKnownState;
  /** Local evidence assessment of continuity between memory and the final reply. */
  memoryContinuityAssessment?: import('./memory-continuity.js').MemoryContinuityAssessment;
  /** Structured request when the result asks the user for information. */
  clarificationRequest?: ClarificationRequest;
  /** Previous clarification answered by this run's inbound message. */
  clarificationResponse?: ClarificationResponse;
  /** Redacted structural evidence for conversation-task continuity. */
  conversationContinuation?: import('./runtime-contracts.js').ConversationContinuationEvidence;
  /** Linked local data/workspace rollback point created for this run. */
  versionCheckpoint?: import('./versioning.js').VersionCheckpointSummary;
}

// ─── Stream events (emitted during a run) ────────────────────────────────

export type StreamEvent =
  | { stream: 'lifecycle'; phase: 'start' | 'end' | 'error'; runId: string; stage?: StageName }
  | { stream: 'assistant'; runId: string; delta: string; stage?: StageName }
  | { stream: 'tool'; runId: string; event: 'start' | 'update' | 'end'; callId: string; name: string; data?: unknown };

/** Lightweight run-progress event for real-time SSE streaming. */
export interface ToolStreamEvent {
  type: 'reasoning' | 'task_book' | 'step_start' | 'step_done' | 'step_failed' | 'step_skipped' | 'tool_start' | 'tool_end' | 'verification_start' | 'verification' | 'final_delta' | 'capability_snapshot' | 'capability_probe'
  /** Runtime-owned disclosure policy; this is never inferred from model text. */
  visibility?: 'silent' | 'progress'
  /** Stable identity for one public, user-visible Harness phase occurrence. */
  phaseId?: string
  /** Harness stage that owns a public reasoning/progress update. */
  stage?: StageName
  /** Lifecycle of a public reasoning/progress update. Raw provider reasoning is never carried here. */
  reasoningStatus?: 'running' | 'done' | 'failed'
  callId?: string
  name?: string
  stepId?: string
  title?: string
  description?: string
  status?: TaskStepStatus
  summary?: string
  input?: unknown
  ok?: boolean
  output?: string
  error?: string
  durationMs?: number
  taskBook?: TaskBook
  verification?: VerificationRecord
  capabilitySnapshot?: import('./capability.js').RuntimeCapabilitySnapshot
  capabilityProbe?: import('./capability.js').RuntimeCapabilityProbe
  permissionEvent?: import('./capability.js').RuntimePermissionEvent
}

// ─── Post-MVP: multi-agent extension points ──────────────────────────────

/** A sub-agent definition (post-MVP). */
export interface SubAgent {
  name: string;
  description: string;
  harness: AgentHarness;
  tools: AgentTool[];
  model?: string;
}

/** Result of spawning a sub-agent (post-MVP). */
export interface SubAgentResult {
  subAgentName: string;
  ok: boolean;
  reply?: string;
  error?: string;
}

/** Orchestrator for multi-agent (post-MVP). MVP only reserves the interface. */
export interface AgentOrchestrator {
  spawn(subAgent: SubAgent, task: string): Promise<SubAgentResult>;
  list(): SubAgent[];
}
