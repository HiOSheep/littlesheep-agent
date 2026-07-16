// Converts one completed run into conservative, evidence-bound atom feedback.

import { createHash } from 'node:crypto';
import type { MemoryRunFeedbackInput } from './types.js';
import type { MemoryUseFeedback } from './v3/contracts.js';

export function memoryUseFeedbackFromRun(input: MemoryRunFeedbackInput): MemoryUseFeedback[] {
  const active = new Set(input.activeAtomIds);
  const released = new Set(input.releasedAtomIds);
  const verified = input.status === 'ok'
    && input.verification?.verdict === 'pass'
    && (input.verification.source === 'structural' || input.successfulToolCallIds.length > 0);
  const evidenceRefs = verified ? runEvidenceRefs(input) : [];
  const feedback: MemoryUseFeedback[] = [];
  const seen = new Set<string>();

  for (const reference of input.references) {
    if (!reference.atomId || seen.has(reference.atomId)) continue;
    seen.add(reference.atomId);
    if (reference.decision === 'conflicted') {
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
    if (verified && reference.decision === 'adopted' && active.has(reference.atomId)) {
      feedback.push(record(
        input,
        reference.atomId,
        'useful',
        true,
        evidenceRefs,
        'The atom remained in the active working set of a successfully verified run with positive execution evidence.',
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
