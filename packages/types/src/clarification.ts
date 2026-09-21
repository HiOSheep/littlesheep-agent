// @littlesheep/types - clarification.ts
// Serializable contract for questions that intentionally pause a run.

/** Why the agent needs another user turn before it can continue safely. */
export type ClarificationKind =
  | 'missing_information'
  | 'ambiguous_request'
  | 'recovery_decision';

/** Stages that may intentionally hand control to ASK_USER. */
export type ClarificationSourceStage =
  | 'classify'
  | 'decide'
  | 'execute'
  | 'recover'
  | 'verify';

/** One answerable field inside a clarification request. */
export interface ClarificationQuestion {
  /** Stable id inside the request, e.g. "question-1". */
  id: string;
  /** Machine-readable field name used to correlate the answer. */
  field: string;
  /** User-facing question, written in the user's language. */
  prompt: string;
  /** Whether execution remains blocked without an answer. */
  required: boolean;
  /** Optional finite choices when the answer space is known. */
  options?: string[];
  /** Optional safe default the user may accept. */
  defaultValue?: string;
}

/** Bounded structural context for a follow-up clarification. */
export interface ClarificationChain {
  version: 1;
  previousRequestId: string;
  previousSourceStage?: ClarificationSourceStage;
  answeredAt: string;
  answeredFields: string[];
  remainingFields: string[];
  taskGoal?: string;
  failureStage?: ClarificationSourceStage;
  attachmentCount: number;
  permissionPolicyId?: 'full' | 'research' | 'restricted';
}

/** First-class, persisted request produced before ASK_USER. */
export interface ClarificationRequest {
  id: string;
  kind: ClarificationKind;
  sourceStage: ClarificationSourceStage;
  createdAt: string;
  originalRequest: string;
  /** Why guessing or continuing would be unsafe or wasteful. */
  blockingReason: string;
  /** Original missing-info labels from demand calibration. */
  missingInfo?: string[];
  questions: ClarificationQuestion[];
  /** Provenance of the structured draft. A runtime fallback must still pass through ASK_USER before display. */
  copySource?: 'model' | 'runtime_fallback';
  /** Exact text shown to the user after ASK_USER renders the request. */
  prompt?: string;
  /**
   * The model request that authored the wording in {@link prompt}.
   *
   * A question the model already asked through a tool call carries its own
   * request id, so the stage that publishes it can cite that request instead of
   * asking the model to word the same question again. Absent when the wording
   * came from a runtime draft, which must not be published as model output.
   */
  copyModelRequestId?: string;
  /** Bounded prior-request facts used to avoid losing correction context. */
  clarificationChain?: ClarificationChain;
}

/** The next user turn linked back to the request it answers. */
export interface ClarificationResponse {
  requestId: string;
  answer: string;
  answeredAt: string;
}
