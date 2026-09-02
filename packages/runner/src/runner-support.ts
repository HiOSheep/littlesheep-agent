// Small Runner-owned projections kept outside the lifecycle facade.
import { sanitizeWebEvidenceProjection, type AgentResult, type Message, type RunContext, type SessionId, type StageResult } from '@littlesheep/types';
import type { MemoryAccessLedger } from '@littlesheep/memory-tree';

export function resolveConversationContinuationMode(value: string | undefined): 'off' | 'shadow' | 'full' {
  return value === 'off' || value === 'shadow' || value === 'full' ? value : 'full';
}

export function checkpointReason(ctx: RunContext, stageResult: StageResult, interrupted: boolean): string {
  if (ctx.runtimeControl?.state === 'paused') return ctx.runtimeControl.reason ?? 'run paused at a safe boundary';
  if (interrupted) return ctx.runtimeControl?.reason ?? 'run interrupted before completion';
  if (ctx.clarificationRequest) return 'run is waiting for user clarification';
  return stageResult.error ?? ctx.lastError?.message ?? 'run requires recovery';
}

export function assembleResult(
  stageResult: StageResult,
  ctx: RunContext,
  sessionId: SessionId,
  startedAtMs: number,
  aborted = false,
  memoryAccess?: MemoryAccessLedger,
): AgentResult & { sessionId: SessionId; memoryAccess?: MemoryAccessLedger } {
  const status: AgentResult['status'] = aborted ? 'aborted' : stageResult.ok ? 'ok' : 'error';
  const trace = (stageResult.meta?.trace as AgentResult['trace']) ?? [];
  return {
    runId: ctx.runId,
    sessionId,
    status,
    reply: ctx.reply ?? '',
    replyProvenance: ctx.replyProvenance,
    finalReplySettlement: ctx.finalReplySettlement,
    error: stageResult.error,
    messages: ctx.produced,
    trace,
    durationMs: Date.now() - startedAtMs,
    usage: ctx.usage,
    resolvedRunConfig: ctx.resolvedRunConfig,
    capabilitySnapshot: ctx.capabilitySnapshot,
    capabilityProbe: ctx.capabilityProbe,
    capabilityPermissionEvent: ctx.capabilityPermissionEvent,
    modelRequests: ctx.modelRequests,
    contextSnapshots: ctx.contextSnapshots,
    taskExecution: ctx.taskExecution,
    toolInvocations: ctx.toolInvocations,
    toolInvocationsTruncated: ctx.toolInvocationsTruncated,
    sideEffects: ctx.sideEffects,
    taskBook: ctx.taskBook ? { ...ctx.taskBook, stageResults: undefined } : undefined,
    verificationHistory: ctx.verificationHistory,
    runtimeControl: ctx.runtimeControl,
    runtimeEventQueue: snapshotRuntimeEventQueue(ctx),
    memoryIntentDecisions: ctx.memoryIntentDecisions,
    memoryKnownState: ctx.memoryKnownState,
    memoryContinuityAssessment: ctx.memoryContinuityAssessment,
    clarificationRequest: ctx.clarificationRequest,
    clarificationResponse: ctx.clarificationResponse,
    conversationContinuation: ctx.conversationContinuation,
    webEvidence: sanitizeWebEvidenceProjection(ctx.webEvidence),
    memoryAccess,
  };
}

function snapshotRuntimeEventQueue(ctx: RunContext) {
  try {
    return ctx.runtimeEventQueue?.snapshot();
  } catch {
    return undefined;
  }
}

export function messageText(message: Message): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
