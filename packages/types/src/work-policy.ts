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

export type ExecutionWorkMode = 'bounded_loop' | 'task_book';

export type WorkPolicyReasonCode =
  | 'bounded_single_goal'
  | 'bounded_default'
  | 'existing_task_book'
  | 'continuation'
  | 'deferred_runtime_event'
  | 'retrieval_required'
  | 'complex_scope'
  | 'large_request'
  | 'uncertain_execution_scope'
  | 'bounded_loop_promoted'
  | 'legacy_checkpoint';

/** Versioned execution policy selected once at the activity-routing boundary. */
export interface WorkPolicy {
  readonly version: 1;
  readonly route: import('./agent.js').AgentActivity;
  readonly sourceMessageId: string;
  readonly executionMode?: ExecutionWorkMode;
  readonly reasonCode: WorkPolicyReasonCode | ClassificationReasonCode;
}
