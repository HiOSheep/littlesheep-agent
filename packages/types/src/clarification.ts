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
  /** Exact text shown to the user after ASK_USER renders the request. */
  prompt?: string;
}

/** The next user turn linked back to the request it answers. */
export interface ClarificationResponse {
  requestId: string;
  answer: string;
  answeredAt: string;
}
