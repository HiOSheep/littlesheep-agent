// @littlesheep/types — agent.ts
// Core Flow state machine types: stages, harness, hooks, run lifecycle.
//
// This is the heart of LittleSheep. The agent loop is a HARD control-flow
// state machine — LLM only decides WITHIN a stage, never WHICH stage comes next.

import type { Message } from './message.js';
import type { CompactionSummary, SessionId } from './session.js';
import type { AgentTool, ToolContext } from './tool.js';
import type { MemoryPrelude } from './memory.js';
import type { ClarificationRequest, ClarificationResponse } from './clarification.js';

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

/** Classification result from CLASSIFY stage. */
export type MessageClass = 'chat' | 'problem' | 'unclear';

export interface Classification {
  type: MessageClass;
  /** 0..1 confidence. Below threshold → LLM fallback. */
  confidence: number;
  /** Which classifier produced this ('rules' | 'llm'). */
  source: 'rules' | 'llm';
  /** Optional reason for debugging. */
  reason?: string;
}

/** Coarse task-size signal produced by DECIDE. */
export type TaskComplexity = 'trivial' | 'simple' | 'standard' | 'complex';

/** Status of a planned task-book step. */
export type TaskStepStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'failed' | 'skipped';

/** Aggregate status of a task-book execution. */
export type TaskExecutionStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'partial';

/** Machine-readable reason a task-book step could not complete. */
export type TaskStepFailureKind =
  | 'tool_error'
  | 'permission_denied'
  | 'not_found'
  | 'model_error'
  | 'verification_gap'
  | 'aborted'
  | 'unknown';

/**
 * DECIDE's demand calibration. This keeps the agent from using a heavyweight
 * workflow for a tiny request, while still planning carefully for hard work.
 */
export interface NeedAssessment {
  /** The user's actual need, stripped of incidental phrasing. */
  userNeed: string;
  /** Size/risk/ambiguity bucket for the task. */
  complexity: TaskComplexity;
  /** The concrete goal this run should achieve. */
  goal: string;
  /** What must be true for the run to count as done. */
  successCriteria: string[];
  /** Missing information that blocks useful execution. */
  missingInfo?: string[];
  /** True when DECIDE should ask the user instead of guessing. */
  needsClarification?: boolean;
  /** Whether the task needs an explicit multi-step task book. */
  requiresTaskBook: boolean;
  /**
   * Upper bound for extra helpful work relative to the user's request.
   * User preference: slightly exceed expectations, never more than 3x scope/cost.
   */
  maxExtraScopeRatio: number;
  /** Short rationale useful for debugging or trace views. */
  rationale?: string;
}

/** A plan step produced by DECIDE. */
export interface PlanStep {
  /** Stable id inside a task book, e.g. "step-1". */
  id?: string;
  /** Short label for UI/debug traces. */
  title?: string;
  /** Step description (natural language). */
  description: string;
  /** Tools this step may need. */
  tools?: string[];
  /** Whether this step requires approval. */
  requiresApproval?: boolean;
  /** Per-step criteria used by VERIFY and future step executors. */
  acceptanceCriteria?: string[];
  /** Expected artifact/result for this step. */
  expectedOutput?: string;
  /** Execution status, reserved for stricter step execution. */
  status?: TaskStepStatus;
}

/** Runtime result for one task-book step. */
export interface TaskStepResult {
  stepId: string;
  title?: string;
  description: string;
  status: TaskStepStatus;
  startedAt: string;
  endedAt?: string;
  acceptanceCriteria?: string[];
  expectedOutput?: string;
  output?: string;
  error?: string;
  /** Failure category used by VERIFY/RECOVER routing. */
  failureKind?: TaskStepFailureKind;
  /** 1 for the first execution, incremented when this step is retried. */
  attempt?: number;
  toolCallIds: string[];
  toolResults: import('./message.js').ToolResult[];
}

/** VERIFY's bounded request to revise only failed/incomplete steps. */
export interface PartialReplanRequest {
  attempt: number;
  requestedAt: string;
  targetStepIds: string[];
  reason: string;
  feedback: string;
}

/** Durable audit record for one partial re-plan cycle. */
export interface TaskReplanRecord extends PartialReplanRequest {
  preservedStepIds: string[];
  revisedStepIds?: string[];
  decidedAt?: string;
  resumedAt?: string;
}

/** Runtime result for the whole task book. */
export interface TaskExecutionResult {
  goal: string;
  complexity: TaskComplexity;
  status: TaskExecutionStatus;
  startedAt: string;
  endedAt?: string;
  summary?: string;
  steps: TaskStepResult[];
  replanHistory?: TaskReplanRecord[];
}

/** Structured task book produced by DECIDE and consumed by EXECUTE/VERIFY. */
export interface TaskBook {
  assessment: NeedAssessment;
  goal: string;
  complexity: TaskComplexity;
  successCriteria: string[];
  steps: PlanStep[];
  overdeliveryPolicy: {
    /** Clamped to 1..3. */
    maxExtraScopeRatio: number;
    guidance: string;
  };
  /** Stage-level outcomes filled by step-aware EXECUTE. */
  stageResults?: TaskStepResult[];
}

/** Durable VERIFY outcome linked to the task book and final reply. */
export interface VerificationRecord {
  attempt: number;
  verdict: 'pass' | 'needs_replan' | 'fail';
  reason: string;
  feedback?: string;
  failedStepIds?: string[];
  verifiedAt: string;
  source: 'model' | 'structural' | 'degraded';
}

/** A recovery decision from RECOVER. */
export type RecoveryDecision =
  | { action: 'retry'; revisedPlan?: PlanStep[]; note?: string }
  | { action: 'escalate'; reason: string }
  | { action: 'abort'; reason: string };

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
  /** Model ref (provider/model). */
  model: string;
  /** Tools available to EXECUTE stage. */
  tools: AgentTool[];
  /** Tool execution context (cwd, approve, signal, log). */
  toolContext: ToolContext;
  /** Memory prelude injected at ENTER. */
  prelude?: MemoryPrelude;
  /** Versioned non-destructive summary of older messages in this session. */
  sessionSummary?: CompactionSummary;
  /** Stable root index for the on-demand runtime memory tree. */
  memoryRootIndex?: string;
  /** Bootstrap file contents (AGENTS/SOUL/USER/TOOLS/MEMORY.md). */
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
  /** Runtime execution result for the current task book. */
  taskExecution?: TaskExecutionResult;
  /** Plan from DECIDE. */
  plan?: PlanStep[];
  /** Tool results from EXECUTE. */
  toolResults?: import('./message.js').ToolResult[];
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
  /** Final reply text. */
  reply?: string;
  /** Token usage reported by the model provider for the reply-bearing call. */
  usage?: RunUsage;
  /** Immutable per-run configuration resolved before the harness starts. */
  resolvedRunConfig?: import('./runtime-contracts.js').ResolvedRunConfig;
  /** Bounded, redacted snapshots of actual model requests made by this run. */
  modelRequests?: import('./runtime-contracts.js').ModelRequestSnapshot[];
  /** Bounded, redacted context snapshots linked from model request snapshots. */
  contextSnapshots?: import('./runtime-contracts.js').ContextSnapshot[];
  /** Configured request occupancy ratio that recommends context compaction. */
  contextCompressionThresholdRatio?: number;
  /** Optional streaming callback for assistant text deltas. */
  onAssistantDelta?: (delta: string) => void;
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
  name?: string;
  kind: 'image' | 'document' | 'file';
  mimeType?: string;
  size?: number;
  /** Stable digest for a verified LS-managed cache entry. */
  contentHash?: string;
  /** Data URL for image inputs when the selected model supports vision. */
  dataUrl?: string;
  /** Ephemeral extracted content. It is never persisted in AgentResult or execution logs. */
  extractedText?: string;
  extractionNote?: string;
  ownership?: import('./runtime-contracts.js').AttachmentOwnership;
  contentState?: import('./runtime-contracts.js').AttachmentContentState;
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
  /** Error text (when status === 'error'). */
  error?: string;
}

/** Final result of a run. */
export interface AgentResult {
  runId: string;
  status: RunStatus;
  reply?: string;
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
  /** Bounded, redacted request observations. */
  modelRequests?: import('./runtime-contracts.js').ModelRequestSnapshot[];
  /** Bounded, redacted context observations. */
  contextSnapshots?: import('./runtime-contracts.js').ContextSnapshot[];
  /** Structured task execution result when DECIDE produced a task book. */
  taskExecution?: TaskExecutionResult;
  /** Calibrated task contract used by EXECUTE/VERIFY. */
  taskBook?: TaskBook;
  /** Durable VERIFY decisions associated with this result. */
  verificationHistory?: VerificationRecord[];
  /** Structured request when the result asks the user for information. */
  clarificationRequest?: ClarificationRequest;
  /** Previous clarification answered by this run's inbound message. */
  clarificationResponse?: ClarificationResponse;
}

// ─── Stream events (emitted during a run) ────────────────────────────────

export type StreamEvent =
  | { stream: 'lifecycle'; phase: 'start' | 'end' | 'error'; runId: string; stage?: StageName }
  | { stream: 'assistant'; runId: string; delta: string; stage?: StageName }
  | { stream: 'tool'; runId: string; event: 'start' | 'update' | 'end'; callId: string; name: string; data?: unknown };

/** Lightweight run event for real-time SSE streaming. */
export interface ToolStreamEvent {
  type: 'task_book' | 'step_start' | 'step_done' | 'step_failed' | 'step_skipped' | 'tool_start' | 'tool_end' | 'verification_start' | 'verification' | 'final_delta'
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
  taskBook?: TaskBook
  verification?: VerificationRecord
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
