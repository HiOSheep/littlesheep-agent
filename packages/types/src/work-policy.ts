// @littlesheep/types — versioned activity-routing work policy.

/** Stable routing reason used by policy code; human-readable rationale is diagnostics only. */
export type ClassificationReasonCode =
  | 'greeting'
  | 'confirmation'
  | 'direct_response_constraint'
  | 'explanation_request'
  | 'negated_action'
  | 'memory_recall'
  | 'explicit_tool_instruction'
  | 'code_context'
  | 'file_context'
  | 'status_question'
  | 'action_request'
  | 'error_report'
  | 'question'
  | 'capability_question'
  | 'capability_probe'
  | 'llm_route_respond'
  | 'llm_route_execute'
  | 'llm_route_clarify'
  | 'deterministic_default_execute'
  | 'classifier_failed';

/**
 * Execution modes this build can run. There is exactly one: every request, new or resumed, executes in
 * the single main loop. Nothing selects a second mode, and the type says so instead of offering a
 * retired one as if it were still a choice.
 */
export type ExecutionWorkMode = 'bounded_loop';

/**
 * Execution modes an **older build** persisted, and the reader still has to accept.
 *
 * `task_book` belonged to the second execution system, which was deleted; a checkpoint written before
 * that still carries the value in `WorkPolicy.executionMode`. It is a historical wire value, not an
 * execution option: restore validates it so old data keeps opening, and the live path never reads it —
 * no code branches on it any more, and a policy carrying it is downgraded to the main loop by the
 * normalization in the checkpoint reader.
 *
 * Supported versions: work-policy version 1 written up to 2026-09-24.
 * Consumer: checkpoint restore validation (`isSupportedPersistedWorkPolicy`).
 * Removal condition: no supported data root contains a persisted policy with this value.
 */
export type PersistedExecutionWorkMode = ExecutionWorkMode | 'task_book';

export type WorkPolicyReasonCode =
  | 'bounded_single_goal'
  | 'bounded_default'
  | 'conversational_default'
  | 'existing_task_book'
  | 'continuation'
  | 'deferred_runtime_event'
  | 'retrieval_required'
  | 'complex_scope'
  | 'large_request'
  | 'uncertain_execution_scope'
  | 'legacy_checkpoint';

/** Versioned execution policy selected once at the activity-routing boundary. */
export interface WorkPolicy {
  readonly version: 1;
  readonly route: import('./agent.js').AgentActivity;
  readonly sourceMessageId: string;
  readonly executionMode?: ExecutionWorkMode;
  readonly reasonCode: WorkPolicyReasonCode | ClassificationReasonCode;
}

/**
 * The on-disk shape of a work policy: what a reader may encounter, including values a retired build
 * wrote. Persisted state is typed with this, execution with `WorkPolicy`, so a historical value cannot
 * quietly become an execution option again.
 */
export interface PersistedWorkPolicy extends Omit<WorkPolicy, 'executionMode'> {
  readonly executionMode?: PersistedExecutionWorkMode;
}
