// @littlesheep/harness - stages/verify/routing.ts
// VERIFY routing: records evidence, publishes verified replies, and routes bounded recovery outcomes.

import { basename, resolve } from 'node:path';
import type {
  RunContext,
  StageResult,
  VerificationRecord,
} from '@littlesheep/types';
import { writeReplanState } from '../../replan-state.js';
import { writeDecisionState } from '../../decision-state.js';
import { recordFailure } from '../../failure-state.js';
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
  ctx.onToolEvent?.({ type: 'verification', visibility: 'silent', verification });
  return verification;
}

export function publishVerifiedReply(ctx: RunContext): void {
  if (!ctx.reply || ctx.replyProvenance?.source !== 'llm') return;
  ctx.onToolEvent?.({ type: 'final_delta', visibility: 'silent', output: ctx.reply });
  ctx.onAssistantReplace?.(ctx.reply);
}

export function verifyTrivialReadOnlyExecution(ctx: RunContext): StageResult | undefined {
  if ((ctx.taskBook?.complexity !== 'trivial' && ctx.taskBook?.complexity !== 'simple')
    || ctx.taskBook.steps.length !== 1) return undefined;
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

/** Verify narrowly structured write-then-read tasks from Runtime evidence. */
export function verifyDeterministicWriteReadExecution(ctx: RunContext): StageResult | undefined {
  const taskBook = ctx.taskBook;
  const execution = ctx.taskExecution;
  if (!taskBook
    || taskBook.steps.length !== 2
    || execution?.status !== 'done'
    || execution.steps.length !== 2
    || !ctx.reply
    || ctx.replyProvenance?.source !== 'llm') {
    return undefined;
  }

  const [writeStep, readStep] = taskBook.steps;
  const [writeResult, readResult] = execution.steps;
  if (writeStep?.toolProposal?.name !== 'write'
    || readStep?.toolProposal?.name !== 'read'
    || writeResult?.status !== 'done'
    || readResult?.status !== 'done'
    || writeResult.error
    || readResult.error) {
    return undefined;
  }

  const writeInput = asRecord(writeStep.toolProposal.input);
  const readInput = asRecord(readStep.toolProposal.input);
  const writePath = stringValue(writeInput?.file_path);
  const readPath = stringValue(readInput?.file_path);
  const expectedContent = stringValue(writeInput?.content);
  if (!writePath || !readPath || expectedContent === undefined
    || readInput?.offset !== undefined || readInput?.limit !== undefined
    || normalizePath(writePath, ctx.cwd) !== normalizePath(readPath, ctx.cwd)) {
    return undefined;
  }

  const writeToolResult = onlySuccessfulToolResult(writeResult.toolResults);
  const readToolResult = onlySuccessfulToolResult(readResult.toolResults);
  if (!writeToolResult || !readToolResult
    || typeof readToolResult.output !== 'string'
    || readToolResult.output !== expectedContent
    || writeResult.toolCallIds.length !== 1
    || readResult.toolCallIds.length !== 1) {
    return undefined;
  }

  const expectedCalls = new Map([
    [writeResult.toolCallIds[0]!, { stepId: writeResult.stepId, toolName: 'write' }],
    [readResult.toolCallIds[0]!, { stepId: readResult.stepId, toolName: 'read' }],
  ]);
  const invocations = ctx.toolInvocations ?? [];
  if (invocations.length !== expectedCalls.size
    || invocations.some((invocation) => {
      const expected = expectedCalls.get(invocation.callId);
      return !expected
        || invocation.status !== 'succeeded'
        || invocation.stepId !== expected.stepId
        || invocation.toolName !== expected.toolName;
    })) {
    return undefined;
  }

  const sideEffects = ctx.sideEffects ?? [];
  if (sideEffects.length !== 1
    || sideEffects[0]?.status !== 'succeeded'
    || sideEffects[0].toolName !== 'write'
    || sideEffects[0].stepId !== writeResult.stepId
    || sideEffects[0].callId !== writeResult.toolCallIds[0]) {
    return undefined;
  }

  const inbound = textOf(ctx.inbound);
  const fileName = basename(resolve(ctx.cwd, writePath));
  if (!inbound.includes(fileName)
    || !inbound.includes(expectedContent)
    || !ctx.reply.includes(fileName)
    || !ctx.reply.includes(expectedContent)) {
    return undefined;
  }

  const chinese = /[\u3400-\u9fff]/u.test(inbound);
  const reason = chinese
    ? 'Runtime 已确认写入步骤成功并持久记录副作用，随后只读步骤从同一路径读回了完全一致的内容；最终回答也包含用户要求的文件名和核对值。'
    : 'Runtime confirmed the write side effect, read the exact content back from the same path, and found the requested file name and verification value in the final reply.';
  recordVerification(ctx, { verdict: 'pass', reason, source: 'structural' });
  publishVerifiedReply(ctx);
  return {
    stage: 'verify',
    next: 'evolve',
    ok: true,
    meta: { verdict: 'pass', runtimeFastPath: true, writeReadFastPath: true, reason },
  };
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

function onlySuccessfulToolResult(
  results: readonly import('@littlesheep/types').ToolResult[],
): import('@littlesheep/types').ToolResult | undefined {
  return results.length === 1 && results[0]?.ok ? results[0] : undefined;
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
    recordFailure(ctx, 'verify', 'verify', feedback);
    return {
      stage: 'verify',
      next: 'recover',
      ok: false,
      error: feedback,
      meta: { failedStepIds: targetStepIds, ...meta },
    };
  }
  if (replanAttempts >= maxReplan) return escalateExhaustedReplan(ctx, reason, feedback);

  const nextReplanAttempts = replanAttempts + 1;
  writeReplanState(ctx, 'verify', {
    replanAttempts: nextReplanAttempts,
    verifyFeedback: feedback,
  });
  installPartialReplan(ctx, targetStepIds, reason, feedback, nextReplanAttempts);
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
