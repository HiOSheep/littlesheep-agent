export interface MemoryRunFeedbackInput {
  runId: string;
  status: 'ok' | 'error' | 'aborted';
  references: Array<{
    atomId: string;
    decision: 'adopted' | 'excluded' | 'conflicted';
    reason: string;
  }>;
  activeAtomIds: string[];
  releasedAtomIds: string[];
  /** Explicitly cited by VERIFY; mere Context presence is insufficient. */
  usedAtomIds?: string[];
  /** Active adopted atoms independently matched in the final reply; routing-only evidence. */
  answerUsedAtomIds?: string[];
  verification?: {
    attempt: number;
    /** `unverified` means Runtime evidence was complete but the acceptance criteria were not judged. */
    verdict: 'pass' | 'unverified' | 'needs_replan' | 'fail';
    source: 'model' | 'structural' | 'degraded';
    verifiedAt: string;
  };
  successfulToolCallIds: string[];
  recordedAt: string;
}
