// Converts one completed run into conservative, evidence-bound atom feedback.

import { createHash } from 'node:crypto';
import type { MemoryRunFeedbackInput } from './memory-feedback-contract.js';
import type { MemoryUseFeedback } from './v3/contracts.js';

export function memoryUseFeedbackFromRun(input: MemoryRunFeedbackInput): MemoryUseFeedback[] {
  const active = new Set(input.activeAtomIds);
  const released = new Set(input.releasedAtomIds);
  const verifyUsed = new Set(input.usedAtomIds ?? []);
  const answerUsed = new Set(input.answerUsedAtomIds ?? []);
  const verification = input.verification;
  const passed = input.status === 'ok' && verification?.verdict === 'pass';
  const answerSupported = input.status === 'ok' && !verification;
  const verified = Boolean(passed && verification
    && (verification.source === 'structural' || input.successfulToolCallIds.length > 0));
  const evidenceRefs = passed ? runEvidenceRefs(input) : [];
  const feedback: MemoryUseFeedback[] = [];
  const seen = new Set<string>();

  for (const reference of input.references) {
    if (!reference.atomId || seen.has(reference.atomId)) continue;
    seen.add(reference.atomId);
    if (reference.decision === 'conflicted' && active.has(reference.atomId) && verifyUsed.has(reference.atomId)) {
      feedback.push(record(input, reference.atomId, 'conflict', false, [], reference.reason));
      continue;
    }
    if (released.has(reference.atomId)) {
      feedback.push(record(
        input,
        reference.atomId,
        'not-useful',
        false,
        [],
        'The atom was explicitly released from this run context; this is routing feedback, not evidence that the atom is false.',
      ));
      continue;
    }
    if (passed
      && reference.decision === 'adopted'
      && active.has(reference.atomId)
      && verifyUsed.has(reference.atomId)) {
      feedback.push(record(
        input,
        reference.atomId,
        'useful',
        verified,
        evidenceRefs,
        verified
          ? 'VERIFY explicitly identified this active adopted atom as material to a successful run with independent positive execution evidence.'
          : 'VERIFY explicitly identified this active adopted atom as material to the successful run; this updates routing only and does not verify the atom as fact.',
      ));
      continue;
    }
    if ((passed || answerSupported)
      && reference.decision === 'adopted'
      && active.has(reference.atomId)
      && answerUsed.has(reference.atomId)) {
      feedback.push(record(
        input,
        reference.atomId,
        'useful',
        false,
        [],
        'The final model-authored reply contained independent anchors from this active adopted atom; this updates routing only and does not verify the atom as fact.',
      ));
    }
  }
  return feedback;
}

function record(
  input: MemoryRunFeedbackInput,
  atomId: string,
  outcome: MemoryUseFeedback['outcome'],
  verified: boolean,
  evidenceRefs: string[],
  reason: string,
): MemoryUseFeedback {
  const digest = createHash('sha256')
    .update(`${input.runId}\0${atomId}\0${outcome}`, 'utf8')
    .digest('hex');
  return {
    id: `memory-feedback:${digest}`,
    atomId,
    runId: input.runId,
    outcome,
    verified,
    evidenceRefs,
    verifyStageId: input.verification ? `${input.runId}:verify:${input.verification.attempt}` : undefined,
    reason,
    createdAt: input.recordedAt,
  };
}

function runEvidenceRefs(input: MemoryRunFeedbackInput): string[] {
  const refs = input.successfulToolCallIds.map((callId) => `run:${input.runId}:tool:${callId}:succeeded`);
  if (input.verification) {
    refs.push(`run:${input.runId}:verification:${input.verification.attempt}:${input.verification.verdict}`);
  }
  return [...new Set(refs)].slice(0, 64);
}
