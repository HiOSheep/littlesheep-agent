// @littlesheep/types - task.ts
// Demand calibration, TaskBook planning, execution, recovery, and verification contracts.

import type { ToolResourceAccess } from './tool.js';

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

/** DECIDE's demand calibration for matching workflow weight to the actual need. */
export interface NeedAssessment {
  userNeed: string;
  complexity: TaskComplexity;
  goal: string;
  successCriteria: string[];
  missingInfo?: string[];
  needsClarification?: boolean;
  requiresTaskBook: boolean;
  /** Helpful extra scope is bounded to 1..3 times the requested scope/cost. */
  maxExtraScopeRatio: number;
  rationale?: string;
}

export type TaskStepSideEffect = 'none' | 'read' | 'write' | 'external';

/** Runtime-verifiable scheduling contract proposed by DECIDE for one step. */
export interface TaskStepExecutionPolicy {
  /** Missing policies and explicit serial policies both execute serially. */
  mode: 'serial' | 'parallel';
  /** Stable ids of earlier steps that must complete first. */
  dependsOn?: string[];
  /** Complete resource envelope; paths use workspace: or normalized fs: keys. */
  resources?: ToolResourceAccess[];
  /** Highest side-effect class expected from this step. */
  sideEffect?: TaskStepSideEffect;
}

/** One DECIDE-authored tool call proposal. Runtime must validate it again before execution. */
export interface TaskStepToolProposal {
  name: string;
  input: unknown;
}

/** A plan step produced by DECIDE. */
export interface PlanStep {
  id?: string;
  title?: string;
  description: string;
  tools?: string[];
  /** Optional bounded proposal for one explicitly named tool. It is never execution authority. */
  toolProposal?: TaskStepToolProposal;
  requiresApproval?: boolean;
  /** Optional scheduling contract. Runtime defaults missing/unsafe contracts to serial. */
  execution?: TaskStepExecutionPolicy;
  acceptanceCriteria?: string[];
  expectedOutput?: string;
  status?: TaskStepStatus;
}

/** Runtime result for one task-book step. */
export interface TaskStepResult {
  stepId: string;
  title?: string;
  description: string;
  status: TaskStepStatus;
  /** Actual scheduling mode selected by Runtime after safety checks. */
  executionMode?: 'serial' | 'parallel';
  /** Validated dependencies retained for checkpoint and trace inspection. */
  dependsOn?: string[];
  startedAt: string;
  endedAt?: string;
  acceptanceCriteria?: string[];
  expectedOutput?: string;
  output?: string;
  error?: string;
  failureKind?: TaskStepFailureKind;
  attempt?: number;
  toolCallIds: string[];
  toolResults: import('./message.js').ToolResult[];
  /** Qualified preview authored by the exact model request that completed this step. */
  replyCandidate?: TaskStepReplyCandidate;
}

export interface TaskStepReplyCandidate {
  version: 1;
  source: 'llm';
  purpose: 'execute_tool_loop';
  runId: string;
  modelRequestId: string;
  goalVersion: number;
  goalFingerprint: string;
  evidenceRevision: string;
  coversGoal: boolean;
  generatedAt: string;
}

/** VERIFY's bounded request to revise only failed/incomplete steps. */
export interface PartialReplanRequest {
  attempt: number;
  requestedAt: string;
  targetStepIds: string[];
  reason: string;
  feedback: string;
}

/** Durable request to promote one bounded execution into a TaskBook. */
export interface WorkPolicyUpgradeRequest {
  version: 1;
  id: string;
  runId: string;
  sourceMessageId: string;
  goalVersion: number;
  requestedAt: string;
  reasonCode: 'dependency_discovered' | 'scope_expanded' | 'acceptance_gap' | 'long_running' | 'budget_pressure';
  reason: string;
  remainingGoal: string;
  completedToolCallIds: string[];
  pendingToolCallIds: string[];
  completedEffectRefs: Array<{
    idempotencyKey: string;
    status: 'succeeded' | 'failed' | 'cancelled';
    callId?: string;
  }>;
  modelAttemptsUsed: number;
  budget: {
    maxModelAttempts: number;
    toolLoopIterationsUsed: number;
    maxToolLoopIterations: number;
    noProgressRounds: number;
  };
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
    maxExtraScopeRatio: number;
    guidance: string;
  };
  stageResults?: TaskStepResult[];
}

/** Durable VERIFY outcome linked to the task book and final reply. */
export interface VerificationRecord {
  attempt: number;
  /**
   * `pass` means Runtime evidence proved the recorded acceptance; `unverified`
   * means every recorded fact is consistent and complete but the acceptance
   * criteria that need human judgement were not judged by anyone.
   */
  verdict: 'pass' | 'unverified' | 'needs_replan' | 'fail';
  reason: string;
  feedback?: string;
  failedStepIds?: string[];
  usedMemoryAtomIds?: string[];
  verifiedAt: string;
  source: 'model' | 'structural' | 'degraded';
}
