// Records successful semantic-cache use without changing immutable summary projections.

import type { SessionManager } from '@littlesheep/session';
import type { CompactionSummary, SessionId, VerificationRecord } from '@littlesheep/types';

export interface SessionSummaryActivationInput {
  sessionManager: SessionManager;
  sessionId: SessionId;
  summary?: CompactionSummary;
  usedSummaryId?: string;
  answerUsedSummaryId?: string;
  runId: string;
  status: 'ok' | 'error' | 'aborted';
  verification?: VerificationRecord;
  recordedAt: string;
}

export async function recordSessionSummaryActivation(
  input: SessionSummaryActivationInput,
): Promise<boolean> {
  if (!input.summary) return false;
  const usedForRun = input.summary.id === input.usedSummaryId;
  const usedByAnswer = input.summary.id === input.answerUsedSummaryId;
  if (!usedForRun && !usedByAnswer) return false;
  // A completed run can support routing usefulness, but historical VERIFY
  // verdicts and successful tools do not establish summary correctness.
  const successfulRunWithNoKnownFailure = input.status === 'ok'
    && (input.verification?.verdict === 'pass' || input.verification?.verdict === 'unverified');
  if (!successfulRunWithNoKnownFailure && !(input.status === 'ok' && usedByAnswer)) return false;
  await input.sessionManager.recordCompactionActivation(input.sessionId, input.summary.id, {
    id: `session-summary-activation:${input.runId}:${input.summary.id}`,
    outcome: 'useful',
    verified: false,
    observedAt: input.recordedAt,
  });
  return true;
}
