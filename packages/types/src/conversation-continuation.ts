// The audit record of one conversation turn bound to an existing task: which
// checkpoint it continued, what the Runtime restored, what it deliberately did
// not, and why the turn was rejected when it never ran. Persisted with the
// execution log and projected to the Local App API, so the shape is a public
// contract: adding a field here is a versioned change.
import type { StageName } from './agent.js';
import type { PermissionPolicyId, RunCheckpointContinuationDisposition } from './runtime-contracts.js';

export const CONVERSATION_CONTINUATION_EVIDENCE_VERSION = 1 as const;

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
  /**
   * What the new run deliberately did not inherit from the checkpoint.
   *
   * Task progress travels; the ceilings that bound one run's autonomous work do
   * not. A run that escalated on a spent budget left the spend at the ceiling, so
   * re-applying it made the user's next turn fail before its first provider
   * request — the same escalation, for every retry, with no new work. The
   * previous spend is reported here because it is history, and the new run gets
   * its own bounded allowance from the current configuration.
   */
  handoff?: {
    /** The failure the source run ended on; this run starts without it. */
    previousFailure?: { stage: StageName; message: string };
    runBudget: {
      previousModelCallsUsed: number;
      previousToolLoopIterationsUsed: number;
      modelCallsAllowed: number;
      toolLoopIterationsAllowed: number;
    };
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
