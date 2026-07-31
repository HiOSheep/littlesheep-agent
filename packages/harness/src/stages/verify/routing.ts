import type {
  RunContext,
  StageResult,
  VerificationRecord,
} from '@littlesheep/types';
import { textOf } from '../_shared.js';
import {
  canRecoverWithPartialReplan,
  deriveReplanTargets,
  hasIncompleteTaskExecution,
  installPartialReplan,
} from './task-state.js';

const RUNTIME_VERIFIABLE_READ_ONLY_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'memory_tree',
  'memory_search',
  'memory_deep_search',
  'session_status',
]);

export function recordVerification(
  ctx: RunContext,
  record: Omit<VerificationRecord, 'attempt' | 'verifiedAt'>,
): VerificationRecord {
  const verification: VerificationRecord = {
    ...record,
    attempt: (ctx.verificationHistory?.length ?? 0) + 1,
    verifiedAt: new Date().toISOString(),
  };
  ctx.verificationHistory = [...(ctx.verificationHistory ?? []), verification];
  ctx.onToolEvent?.({ type: 'verification', verification });
  return verification;
}

export function publishVerifiedReply(ctx: RunContext): void {
  if (!ctx.reply || ctx.replyProvenance?.source !== 'llm') return;
  ctx.onToolEvent?.({ type: 'final_delta', output: ctx.reply });
  ctx.onAssistantReplace?.(ctx.reply);
}

export function verifyTrivialReadOnlyExecution(ctx: RunContext): StageResult | undefined {
  if (ctx.taskBook?.complexity !== 'trivial' || ctx.taskBook.steps.length !== 1) return undefined;
  const execution = ctx.taskExecution;
  if (execution?.status !== 'done' || execution.steps.length !== 1) return undefined;
  const step = execution.steps[0]!;
  if (step.status !== 'done' || step.error || !step.output?.trim()) return undefined;
  if (step.toolResults.length === 0 || step.toolResults.some((result) => !result.ok)) return undefined;
  if ((ctx.sideEffects?.length ?? 0) > 0) return undefined;
  if (!ctx.reply || ctx.replyProvenance?.source !== 'llm') return undefined;

  const expectedCallIds = new Set(step.toolCallIds);
  const invocations = (ctx.toolInvocations ?? []).filter((invocation) => expectedCallIds.has(invocation.callId));
  if (expectedCallIds.size === 0 || invocations.length !== expectedCallIds.size) return undefined;
  if (invocations.some((invocation) => (
    invocation.status !== 'succeeded'
    || !RUNTIME_VERIFIABLE_READ_ONLY_TOOLS.has(invocation.toolName)
  ))) return undefined;

  const chinese = /[\u3400-\u9fff]/u.test(textOf(ctx.inbound));
  const reason = chinese
    ? '运行时已确认唯一的只读步骤完成，工具调用全部成功，且未产生写入或外部副作用。'
    : 'Runtime confirmed the single read-only step completed, every tool call succeeded, and no write or external side effect occurred.';
  recordVerification(ctx, { verdict: 'pass', reason, source: 'structural' });
  publishVerifiedReply(ctx);
  return {
    stage: 'verify',
    next: 'evolve',
    ok: true,
    meta: { verdict: 'pass', runtimeFastPath: true, reason },
  };
}

export function routeKnownIncompleteExecution(
  ctx: RunContext,
  replanAttempts: number,
  maxReplan: number,
  reason: string,
  meta: Record<string, unknown>,
): StageResult {
  if (!hasIncompleteTaskExecution(ctx)) {
    recordVerification(ctx, { verdict: 'pass', reason, source: 'degraded' });
    publishVerifiedReply(ctx);
    return {
      stage: 'verify',
      next: 'evolve',
      ok: true,
      meta: { degradedPass: true, reason, ...meta },
    };
  }

  const targetStepIds = deriveReplanTargets(ctx, undefined);
  const feedback = `Recorded step evidence is incomplete: ${reason}`;
  if (!canRecoverWithPartialReplan(ctx, targetStepIds)) {
    recordVerification(ctx, {
      verdict: 'fail',
      reason,
      feedback,
      failedStepIds: targetStepIds,
      source: 'structural',
    });
    ctx.lastError = { stage: 'verify', message: feedback };
    return {
      stage: 'verify',
      next: 'recover',
      ok: false,
      error: feedback,
      meta: { failedStepIds: targetStepIds, ...meta },
    };
  }
  if (replanAttempts >= maxReplan) return escalateExhaustedReplan(ctx, reason, feedback);

  ctx.replanAttempts = replanAttempts + 1;
  ctx.verifyFeedback = feedback;
  installPartialReplan(ctx, targetStepIds, reason, feedback, ctx.replanAttempts);
  recordVerification(ctx, {
    verdict: 'needs_replan',
    reason,
    feedback,
    failedStepIds: targetStepIds,
    source: 'degraded',
  });
  return {
    stage: 'verify',
    next: 'decide',
    ok: true,
    meta: {
      degradedReplan: true,
      failedStepIds: targetStepIds,
      replanAttempts: ctx.replanAttempts,
      ...meta,
    },
  };
}

export function escalateExhaustedReplan(ctx: RunContext, reason: string, feedback: string): StageResult {
  const originalRequest = textOf(ctx.inbound);
  const chinese = /[\u3400-\u9fff]/u.test(originalRequest);
  ctx.partialReplanRequest = undefined;
  ctx.clarificationRequest = {
    id: `${ctx.runId}:clarification`,
    kind: 'recovery_decision',
    sourceStage: 'verify',
    createdAt: new Date().toISOString(),
    originalRequest,
    copySource: 'runtime_fallback',
    blockingReason: chinese
      ? `自动局部重规划已达到上限，任务仍未达标：${feedback || reason}`
      : `Automatic partial re-planning reached its limit and the task is still incomplete: ${feedback || reason}`,
    questions: [{
      id: 'question-1',
      field: 'replanDecision',
      prompt: chinese ? '你希望我接下来如何处理？' : 'How would you like me to proceed?',
      required: true,
      options: chinese
        ? ['保留已完成部分并说明现状', '再尝试一次', '停止任务']
        : ['Keep completed work and explain the status', 'Try once more', 'Stop the task'],
    }],
  };
  recordVerification(ctx, {
    verdict: 'fail',
    reason,
    feedback,
    failedStepIds: deriveReplanTargets(ctx, undefined),
    source: 'structural',
  });
  return {
    stage: 'verify',
    next: 'ask_user',
    ok: true,
    meta: {
      replanExhausted: true,
      replanAttempts: ctx.replanAttempts ?? 0,
      reason,
    },
  };
}
