// @littlesheep/harness - stages/verify/routing.ts
// VERIFY routing: records evidence, publishes verified replies, and routes bounded recovery outcomes.

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type {
  RunContext,
  StageResult,
  VerificationRecord,
} from '@littlesheep/types';
import { writeReplanState } from '../../replan-state.js';
import { writeDecisionState } from '../../decision-state.js';
import { recordFailure } from '../../failure-state.js';
import { clearReplyState } from '../../reply-state.js';
import { textOf } from '../_shared.js';

const RUNTIME_VERIFIABLE_READ_ONLY_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'session_status',
]);

export async function recordVerification(
  ctx: RunContext,
  record: Omit<VerificationRecord, 'attempt' | 'verifiedAt'>,
): Promise<VerificationRecord> {
  const verification: VerificationRecord = {
    ...record,
    attempt: (ctx.verificationHistory?.length ?? 0) + 1,
    verifiedAt: new Date().toISOString(),
  };
  ctx.verificationHistory = [...(ctx.verificationHistory ?? []), verification];
  await ctx.appendDurableEvent?.({
    type: 'verification_recorded',
    source: 'runtime',
    eventId: `${ctx.runId}:verification:${verification.attempt}`,
    idempotencyKey: `${ctx.runId}:verification:${verification.attempt}`,
    payload: {
      attempt: verification.attempt,
      verdict: verification.verdict,
      source: verification.source,
      reasonHash: createHash('sha256').update(verification.reason, 'utf8').digest('hex'),
      reasonLength: verification.reason.length,
      ...(verification.failedStepIds
        ? { failedStepIds: verification.failedStepIds.slice(0, 64) }
        : {}),
    },
  });
  ctx.onToolEvent?.({ type: 'verification', visibility: 'silent', verification });
  return verification;
}

/**
 * VERIFY records evidence only. FINALIZE owns the sole user-facing settlement
 * and channel projections consume that settlement from the completed result.
 */
export function publishVerifiedReply(_ctx: RunContext): void {
  return;
}

/**
 * The narrow read-only pass, judged from the evidence a current run actually produces.
 *
 * This used to require a `taskBook` step and its `taskExecution` result, which no run creates any more:
 * the check could only ever be satisfied by a test hand-building the retired structures, so the branch was
 * unreachable in production (HC-03). The live facts are the same facts the old plan carried — which tool
 * ran, whether it succeeded, whether the output reached the model intact, and whether anything was
 * written — and they come from the run's own invocation, result and side-effect records.
 *
 * Still narrow on purpose: exactly one tool call in the whole run, a builtin read-only tool, an unsanitized
 * success, no side effect at all, and a Provider-authored reply. Anything wider stays `unverified`.
 */
export async function verifyTrivialReadOnlyExecution(ctx: RunContext): Promise<StageResult | undefined> {
  const invocations = ctx.toolInvocations ?? [];
  if (invocations.length !== 1) return undefined;
  const invocation = invocations[0]!;
  if (invocation.status !== 'succeeded'
    || invocation.toolSource !== 'builtin'
    || invocation.outputTruncated === true
    || !RUNTIME_VERIFIABLE_READ_ONLY_TOOLS.has(invocation.toolName)) return undefined;
  if ((ctx.sideEffects?.length ?? 0) > 0) return undefined;
  if (!ctx.reply?.trim() || ctx.replyProvenance?.source !== 'llm') return undefined;
  const result = (ctx.toolResults ?? []).find((candidate) => candidate.callId === invocation.callId);
  if (!result || !result.ok || result.sanitized) return undefined;

  const chinese = /[\u3400-\u9fff]/u.test(textOf(ctx.inbound));
  const reason = chinese
    ? '运行时已确认本次运行只有一次只读工具调用且成功、输出完整，并未产生任何写入或外部副作用。'
    : 'Runtime confirmed the run made exactly one read-only tool call, it succeeded with an intact output, and no write or external side effect occurred.';
  await recordVerification(ctx, { verdict: 'pass', reason, source: 'structural' });
  publishVerifiedReply(ctx);
  return {
    stage: 'verify',
    next: 'finalize',
    ok: true,
    meta: { verdict: 'pass', runtimeFastPath: true, reason },
  };
}

/** Verify a narrowly structured write-then-read run from Runtime evidence. */
export async function verifyDeterministicWriteReadExecution(ctx: RunContext): Promise<StageResult | undefined> {
  const invocations = ctx.toolInvocations ?? [];
  if (invocations.length !== 2) return undefined;
  const [writeInvocation, readInvocation] = invocations;
  if (writeInvocation?.toolName !== 'write' || readInvocation?.toolName !== 'read') return undefined;
  if (!ctx.reply || ctx.replyProvenance?.source !== 'llm') return undefined;
  if ([writeInvocation, readInvocation].some((invocation) => (
    invocation.status !== 'succeeded'
    || invocation.toolSource !== 'builtin'
    || invocation.outputTruncated === true
  ))) return undefined;

  // The arguments come from the run's own transcript: the same assistant tool calls the model produced,
  // not a plan a deleted executor wrote.
  const writeInput = asRecord(toolCallInput(ctx, writeInvocation.callId));
  const readInput = asRecord(toolCallInput(ctx, readInvocation.callId));
  const writePath = stringValue(writeInput?.file_path);
  const readPath = stringValue(readInput?.file_path);
  const expectedContent = stringValue(writeInput?.content);
  if (!writePath || !readPath || expectedContent === undefined
    || readInput?.offset !== undefined || readInput?.limit !== undefined
    || normalizePath(writePath, ctx.cwd) !== normalizePath(readPath, ctx.cwd)) {
    return undefined;
  }

  const writeResult = (ctx.toolResults ?? []).find((candidate) => candidate.callId === writeInvocation.callId);
  const readResult = (ctx.toolResults ?? []).find((candidate) => candidate.callId === readInvocation.callId);
  if (!writeResult?.ok || !readResult?.ok || writeResult.sanitized || readResult.sanitized
    || typeof readResult.output !== 'string'
    || readResult.output !== expectedContent) {
    return undefined;
  }

  const sideEffects = ctx.sideEffects ?? [];
  if (sideEffects.length !== 1
    || sideEffects[0]?.status !== 'succeeded'
    || sideEffects[0].toolName !== 'write'
    || sideEffects[0].callId !== writeInvocation.callId) {
    return undefined;
  }

  const chinese = /[\u3400-\u9fff]/u.test(textOf(ctx.inbound));
  const reason = chinese
    ? 'Runtime 已确认写入调用成功并持久记录副作用，随后同一路径的只读调用读回了与写入参数完全一致的内容。'
    : 'Runtime confirmed the write call succeeded with a recorded side effect, and a later read of the same path returned exactly the bytes the write was given.';
  await recordVerification(ctx, { verdict: 'pass', reason, source: 'structural' });
  publishVerifiedReply(ctx);
  return {
    stage: 'verify',
    next: 'finalize',
    ok: true,
    meta: { verdict: 'pass', runtimeFastPath: true, writeReadFastPath: true, reason },
  };
}

/** The `input` of a tool call the run's transcript recorded, by call id. */
function toolCallInput(ctx: RunContext, callId: string): unknown {
  for (const message of ctx.history ?? []) {
    for (const block of message.content ?? []) {
      if (block.type !== 'tool_calls') continue;
      const call = block.calls.find((candidate: { id: string }) => candidate.id === callId);
      if (call) return call.input;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizePath(value: string, cwd: string): string {
  const normalized = resolve(cwd, value).replace(/\\/gu, '/');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}



export async function routeKnownIncompleteExecution(
  ctx: RunContext,
  replanAttempts: number,
  maxReplan: number,
  reason: string,
  meta: Record<string, unknown>,
): Promise<StageResult> {
  invalidateUnverifiedReply(ctx);
  const feedback = `Recorded step evidence is incomplete: ${reason}`;
  // There is no partial re-plan here any more (HC-03). It existed to re-plan the steps of the deleted
  // executor: it required a TaskBook, installed a step-scoped request, and the stage that consumed that
  // request (DECIDE) went with the second execution system — on a current run the condition could never be
  // met, so a gap always took this branch anyway. An evidence gap is a recorded negative outcome and
  // RECOVER owns the bounded retry, so say what is missing and let it route.
  void replanAttempts;
  void maxReplan;
  await recordVerification(ctx, { verdict: 'fail', reason, feedback, source: 'structural' });
  recordFailure(ctx, 'verify', 'verify', feedback);
  return { stage: 'verify', next: 'recover', ok: false, error: feedback, meta };
}

export async function escalateExhaustedReplan(ctx: RunContext, reason: string, feedback: string): Promise<StageResult> {
  invalidateUnverifiedReply(ctx);
  const originalRequest = textOf(ctx.inbound);
  const chinese = /[\u3400-\u9fff]/u.test(originalRequest);
  writeReplanState(ctx, 'verify', { partialReplanRequest: undefined });
  writeDecisionState(ctx, 'verify', { clarificationRequest: {
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
  } });
  await recordVerification(ctx, {
    verdict: 'fail',
    reason,
    feedback,
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

export function invalidateUnverifiedReply(ctx: RunContext): void {
  ctx.onAssistantReplace?.('');
  clearReplyState(ctx, 'verify');
}