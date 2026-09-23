// @littlesheep/harness — stages/recover.ts
// RECOVER: Runtime-owned routing after a stage failed. No model request: the
// decision follows from recorded facts (see recover/policy.ts), retries are
// bounded by `maxRecoveryAttempts`, and anything the Runtime cannot decide
// safely is handed back to the user through ASK_USER.

import type { RunContext, StageResult } from '@littlesheep/types';
import { textOf } from './_shared.js';
import { decideRecovery } from './recover/policy.js';
import {
  blockingCauseLabel,
  classifyBlockingCause,
  completedWorkSummary,
  requiredActionFor,
} from './recover/escalation.js';
import { writeDecisionState } from '../decision-state.js';
import { incrementRecoveryAttempts, recordFailure } from '../failure-state.js';

/** Factory: creates the deterministic recover stage. */
export function createRecoverStage() {
  const consumedContinuationRetries = new WeakSet<RunContext>();

  return async function recoverStage(ctx: RunContext): Promise<StageResult> {
    const recoveryAttempts = incrementRecoveryAttempts(ctx, 'recover');
    const lastError = ctx.lastError;

    // A bound user retry is a new runtime decision, even when the checkpoint
    // already exhausted its autonomous recovery budget. Runner has already
    // restored and revalidated resources and current permissions before this
    // boundary. Consume exactly one deterministic retry for this resumed run;
    // a subsequent EXECUTE failure returns here under the normal recovery cap.
    if (isBoundContinuationRetry(ctx) && !consumedContinuationRetries.has(ctx)) {
      consumedContinuationRetries.add(ctx);
      return {
        stage: 'recover',
        next: 'execute',
        ok: true,
        meta: {
          deterministicContinuationRetry: true,
          attempts: recoveryAttempts,
          failedStage: lastError?.stage,
          resumedFromCheckpointId: ctx.resumedFromCheckpointId,
        },
      };
    }

    // Force-escalate once the autonomous retry budget is exhausted.
    if (recoveryAttempts > ctx.maxRecoveryAttempts) {
      writeEscalationRequest(ctx, 'recovery_budget_exhausted', recoveryAttempts);
      return {
        stage: 'recover',
        next: 'ask_user',
        ok: true,
        meta: { forcedEscalate: true, attempts: recoveryAttempts, reasonCode: 'recovery_budget_exhausted' },
      };
    }

    const plan = decideRecovery(ctx, recoveryAttempts);

    if (plan.action === 'retry') {
      return {
        stage: 'recover',
        next: plan.next,
        ok: true,
        meta: {
          deterministicRetry: true,
          attempts: recoveryAttempts,
          reasonCode: plan.reasonCode,
          failedStage: lastError?.stage,
        },
      };
    }

    if (plan.action === 'abort') {
      const message = abortStatusMessage(ctx, plan.reasonCode);
      recordFailure(ctx, 'recover', 'recover', message);
      return {
        stage: 'recover',
        next: 'exit',
        ok: false,
        error: message,
        meta: { action: 'abort', attempts: recoveryAttempts, reasonCode: plan.reasonCode },
      };
    }
    writeEscalationRequest(ctx, plan.reasonCode, recoveryAttempts);

    return {
      stage: 'recover',
      next: 'ask_user',
      ok: true,
      meta: { action: 'escalate', attempts: recoveryAttempts, reasonCode: plan.reasonCode },
    };
  };
}
/**
 * Runtime-authored clarification facts. ASK_USER composes the user-visible
 * wording from a real model call; RECOVER never authors reply text.
 *
 * What RECOVER does owe the user is the three facts that make the same question
 * answerable: which cause it stopped for, what the run already finished, and what
 * would have to change to continue. Without them the same three-way question came
 * back for a permission refusal, a missing file and an unrecoverable evidence
 * gap alike, and the model composing the message had nothing to separate them
 * with.
 */
function writeEscalationRequest(ctx: RunContext, reasonCode: string, recoveryAttempts: number): void {
  const originalRequest = textOf(ctx.inbound);
  const chinese = /[\u3400-\u9fff]/u.test(originalRequest);
  const detail = ctx.lastError?.message ?? 'execution could not continue safely';
  const cause = classifyBlockingCause(ctx, reasonCode);
  const causeLabel = blockingCauseLabel(cause, chinese);
  const requiredAction = requiredActionFor(cause, chinese);
  const completed = completedWorkSummary(ctx, chinese);
  const blockingReason = chinese
    ? `已在第 ${recoveryAttempts} 次恢复尝试后停止（原因类别：${causeLabel}）。具体原因：${detail}。已完成：${completed}。继续所需：${requiredAction}。`
    : `Stopped after recovery attempt ${recoveryAttempts} (cause: ${causeLabel}). Reason: ${detail}. Already finished: ${completed}. Needed to continue: ${requiredAction}.`;
  writeDecisionState(ctx, 'recover', { clarificationRequest: {
    id: `${ctx.runId}:clarification`,
    kind: 'recovery_decision',
    sourceStage: 'recover',
    createdAt: new Date().toISOString(),
    originalRequest,
    copySource: 'runtime_fallback',
    blockingReason,
    questions: [{
      id: 'question-1',
      field: 'recoveryDecision',
      prompt: chinese
        ? `执行因「${causeLabel}」停下：${requiredAction}。你希望我接下来如何处理？`
        : `Execution stopped for one reason — ${causeLabel}: ${requiredAction}. How would you like me to proceed?`,
      required: true,
      options: chinese
        ? ['再尝试一次', '保留已完成部分并说明现状', '停止任务']
        : ['Try once more', 'Keep completed work and explain the status', 'Stop the task'],
    }],
  } });
}

function abortStatusMessage(ctx: RunContext, reasonCode: string): string {
  const chinese = /[\u3400-\u9fff]/u.test(textOf(ctx.inbound));
  const detail = ctx.lastError?.message ?? 'execution could not continue';
  if (reasonCode === 'unsettled_side_effect') {
    return chinese
      ? `已停止本轮执行：有工具副作用未能结算（${detail}）。为避免重复执行，Runtime 不会自动重试，也不会发布模型文案。`
      : `Run stopped: a tool side effect was not settled (${detail}). The Runtime will not retry it automatically or publish model text.`;
  }
  return chinese
    ? `已停止本轮执行：${detail}`
    : `Run stopped: ${detail}`;
}


function isBoundContinuationRetry(ctx: RunContext): boolean {
  const continuation = ctx.conversationContinuation;
  return Boolean(
    ctx.resumedFromCheckpointId
    && continuation?.resolution === 'bound'
    && continuation.disposition === 'retry'
    && continuation.resumeStage === 'recover',
  );
}
