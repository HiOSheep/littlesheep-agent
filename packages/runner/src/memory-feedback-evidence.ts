import type { MemoryRunFeedbackInput } from '@littlesheep/memory-tree';
import type { RunContext, VerificationRecord } from '@littlesheep/types';

const NON_EVIDENTIARY_TOOL_NAMES = new Set([
  'memory_tree',
  'memory_search',
  'memory_deep_search',
  'use_skill',
]);

export function independentSuccessfulToolCallIds(ctx: RunContext): string[] {
  const toolNameByCallId = new Map<string, string>();
  for (const message of ctx.produced) {
    for (const block of message.content) {
      if (block.type !== 'tool_calls') continue;
      for (const call of block.calls) toolNameByCallId.set(call.id, call.name);
    }
  }
  return (ctx.toolResults ?? [])
    .filter((result) => {
      if (!result.ok) return false;
      const toolName = toolNameByCallId.get(result.callId);
      return Boolean(toolName && !NON_EVIDENTIARY_TOOL_NAMES.has(toolName));
    })
    .map((result) => result.callId);
}

export function buildMemoryRunFeedbackInput(input: {
  ctx: RunContext;
  status: MemoryRunFeedbackInput['status'];
  verification?: VerificationRecord;
  successfulToolCallIds: string[];
  recordedAt: string;
}): MemoryRunFeedbackInput {
  const { ctx, status, verification, successfulToolCallIds, recordedAt } = input;
  const answerUsedAtomIds = ctx.memoryContinuityAssessment?.status === 'supported'
    ? ctx.memoryContinuityAssessment.matchedAtomIds
    : [];
  return {
    runId: ctx.runId,
    status,
    references: (ctx.memoryKnownState?.references ?? []).map((reference) => ({
      atomId: reference.atomId,
      decision: reference.decision,
      reason: reference.reason,
    })),
    activeAtomIds: [...(ctx.memoryContextWorkingSet?.activeAtomIds ?? [])],
    releasedAtomIds: [...(ctx.memoryContextWorkingSet?.releasedAtomIds ?? [])],
    usedAtomIds: [...(verification?.usedMemoryAtomIds ?? [])],
    answerUsedAtomIds: [...answerUsedAtomIds],
    verification: verification ? {
      attempt: verification.attempt,
      verdict: verification.verdict,
      source: verification.source,
      verifiedAt: verification.verifiedAt,
    } : undefined,
    successfulToolCallIds,
    recordedAt,
  };
}
