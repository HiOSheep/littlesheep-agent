// Runtime-owned settlement of execution facts. This deliberately does not
// decide whether the user's goal was accepted; it only checks that the run's
// recorded calls, results, side effects, and Provider-authored reply agree.
import { createHash } from 'node:crypto';
import type {
  RunContext,
  SideEffectCheckpoint,
  ToolInvocationRecord,
  ToolResult,
  VerificationRecord,
} from '@littlesheep/types';
import { recordFailure } from '../../failure-state.js';
import { clearReplyState } from '../../reply-state.js';
import { appendVerificationRecord } from '../../execution-evidence-state.js';
import {
  TOOL_NOT_ADMITTED_ERROR_KIND,
  TOOL_LOOP_FINAL_REFUSAL_KIND,
  USER_INPUT_REQUEST_SIBLING_REFUSAL_KIND,
} from './tool-result-persistence.js';

export const EXECUTION_EVIDENCE_GAP_PREFIX = 'Execution evidence gap:';

export type RuntimeEvidenceAssessment =
  | { kind: 'complete'; knownFailures: string[] }
  | { kind: 'gap'; reason: string };

const UNSETTLED_EFFECT_STATUSES = new Set<SideEffectCheckpoint['status']>([
  'planned',
  'in_progress',
  'unknown',
]);

const RECORDED_FAILURE_STATUSES = new Set<ToolInvocationRecord['status']>([
  'validation_failed',
  'unknown_tool',
  'repeated_call_blocked',
  'failed',
  'timed_out',
  'aborted',
]);

const PERMISSION_BLOCKING_STATUSES = new Set<ToolInvocationRecord['status']>([
  'approval_denied',
  'approval_unavailable',
  'hard_denied',
]);

/** Pure check over Runtime-owned records. A complete result is not task acceptance. */
export function assessRuntimeEvidence(
  ctx: RunContext,
  options: { requireReply: boolean; userInputRequest?: boolean },
): RuntimeEvidenceAssessment {
  if (ctx.toolInvocationsTruncated) return gap('tool invocation evidence is truncated');

  const invocations = ctx.toolInvocations ?? [];
  const callIds = new Set<string>();
  const invocationIds = new Set<string>();
  for (const invocation of invocations) {
    if (!invocation.id || invocationIds.has(invocation.id)) {
      return gap(`tool invocation identity ${invocation.id || '(missing)'} is duplicated or missing`);
    }
    invocationIds.add(invocation.id);
    if (!invocation.callId || callIds.has(invocation.callId)) {
      return gap(`tool invocation call identity ${invocation.callId || '(missing)'} is duplicated or missing`);
    }
    callIds.add(invocation.callId);
    if (invocation.runId !== ctx.runId || invocation.sessionId !== ctx.sessionId) {
      return gap(`tool invocation ${invocation.callId} belongs to a different run or session`);
    }
  }

  const calls = producedToolCalls(ctx);
  const results = producedToolResults(ctx);
  if (!results) return gap('tool result identities are duplicated or inconsistent');
  for (const [callId, names] of calls) {
    if (!callId || names.length !== 1) {
      return gap(`recorded tool call identity ${callId || '(missing)'} is duplicated or missing`);
    }
    const matchingInvocations = invocations.filter((invocation) => invocation.callId === callId);
    if (matchingInvocations.length === 0
      && names[0] === 'request_user_input'
      && options.userInputRequest === true
      && !results.has(callId)) {
      continue;
    }
    if (matchingInvocations.length === 0 && isRuntimePreExecutionRefusal(results.get(callId))) {
      continue;
    }
    if (matchingInvocations.length !== 1) {
      return gap(`recorded tool call ${callId} does not have exactly one invocation record`);
    }
  }
  for (const invocation of invocations) {
    const matchingCalls = calls.get(invocation.callId) ?? [];
    if (matchingCalls.length !== 1 || matchingCalls[0] !== invocation.toolName) {
      return gap(`tool invocation ${invocation.callId} does not match one recorded tool call`);
    }
    if (PERMISSION_BLOCKING_STATUSES.has(invocation.status)) {
      return gap(`tool invocation ${invocation.callId} is ${invocation.status}`);
    }
    if (invocation.outputTruncated) return gap(`tool invocation ${invocation.callId} output is truncated`);
  }

  for (const callId of results.keys()) {
    if (!calls.has(callId)) return gap(`tool result ${callId} has no matching recorded tool call`);
  }
  for (const invocation of invocations) {
    const result = results.get(invocation.callId);
    if (!result) return gap(`tool result ${invocation.callId} is missing`);
    if (invocation.status === 'proposed' || invocation.status === 'running') {
      return gap(`tool invocation ${invocation.callId} has not reached a terminal status`);
    }
    if (invocation.status === 'succeeded' && !result.ok) {
      return gap(`tool invocation ${invocation.callId} succeeded but its result failed`);
    }
    if (invocation.status !== 'succeeded' && result.ok) {
      return gap(`tool invocation ${invocation.callId} did not succeed but its result succeeded`);
    }
  }

  const sideEffectGap = sideEffectEvidenceGap(ctx, invocations, callIds);
  if (sideEffectGap) return gap(sideEffectGap);

  if (options.requireReply) {
    const replyGap = providerReplyEvidenceGap(ctx);
    if (replyGap) return gap(replyGap);
  }

  return {
    kind: 'complete',
    knownFailures: recordedExecutionFailures(invocations, ctx.sideEffects ?? []),
  };
}

/** Record one completed settlement using the legacy durable record contract. */
export async function recordRuntimeEvidenceSettlement(
  ctx: RunContext,
  assessment: RuntimeEvidenceAssessment,
  stage: 'execute' | 'recover' = 'execute',
): Promise<VerificationRecord> {
  const chinese = /[\u3400-\u9fff]/u.test(inboundText(ctx));
  const verdict = assessment.kind === 'gap' ? 'fail' : 'unverified';
  const reason = assessment.kind === 'gap'
    ? assessment.reason
    : assessment.knownFailures.length > 0
      ? knownFailureReason(assessment.knownFailures, chinese)
      : completeEvidenceReason(chinese);
  const verification: VerificationRecord = {
    attempt: (ctx.verificationHistory?.length ?? 0) + 1,
    verdict,
    reason,
    verifiedAt: new Date().toISOString(),
    source: 'structural',
  };
  appendVerificationRecord(ctx, stage, verification);
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
    },
  });
  ctx.onToolEvent?.({ type: 'verification', visibility: 'silent', verification });
  return verification;
}

/** Fail closed and route an execution evidence gap through the existing RECOVER policy. */
export async function routeExecutionEvidenceGap(
  ctx: RunContext,
  reason: string,
): Promise<import('@littlesheep/types').StageResult> {
  const feedback = `${EXECUTION_EVIDENCE_GAP_PREFIX} ${reason}`;
  await recordRuntimeEvidenceSettlement(ctx, { kind: 'gap', reason });
  ctx.onAssistantReplace?.('');
  clearReplyState(ctx, 'execute');
  recordFailure(ctx, 'execute', 'execute', feedback);
  return {
    stage: 'execute',
    next: 'recover',
    ok: false,
    error: feedback,
    meta: { runtimeEvidenceGap: reason },
  };
}

export function evidenceGapFailure(error: RunContext['lastError']): boolean {
  return error?.message.startsWith(EXECUTION_EVIDENCE_GAP_PREFIX) === true;
}

function producedToolCalls(ctx: RunContext): Map<string, string[]> {
  const calls = new Map<string, string[]>();
  for (const message of ctx.produced) {
    if (message.runId && message.runId !== ctx.runId) continue;
    for (const block of message.content) {
      if (block.type !== 'tool_calls') continue;
      for (const call of block.calls) {
        const names = calls.get(call.id) ?? [];
        names.push(call.name);
        calls.set(call.id, names);
      }
    }
  }
  return calls;
}

function producedToolResults(ctx: RunContext): Map<string, ToolResult> | undefined {
  const results = new Map<string, ToolResult>();
  for (const message of ctx.produced) {
    if (message.runId && message.runId !== ctx.runId) continue;
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      const previous = results.get(block.result.callId);
      if (previous) return undefined;
      results.set(block.result.callId, block.result);
    }
  }
  // Tests and older direct callers may construct RunContext.toolResults without
  // produced messages. Keep that read compatibility, while treating collisions
  // with the persisted projection as ambiguous evidence.
  for (const result of ctx.toolResults ?? []) {
    const previous = results.get(result.callId);
    if (previous) {
      if (!sameToolResult(previous, result)) return undefined;
      continue;
    }
    results.set(result.callId, result);
  }
  return results;
}

function sameToolResult(left: ToolResult, right: ToolResult): boolean {
  try {
    return left.callId === right.callId
      && left.ok === right.ok
      && left.sanitized === right.sanitized
      && JSON.stringify(left.output) === JSON.stringify(right.output)
      && left.error === right.error;
  } catch {
    return false;
  }
}

function isRuntimePreExecutionRefusal(result: ToolResult | undefined): boolean {
  const errorKind = result?.meta?.errorKind;
  return errorKind === TOOL_NOT_ADMITTED_ERROR_KIND
    || errorKind === TOOL_LOOP_FINAL_REFUSAL_KIND
    || errorKind === USER_INPUT_REQUEST_SIBLING_REFUSAL_KIND;
}

function sideEffectEvidenceGap(
  ctx: RunContext,
  invocations: readonly ToolInvocationRecord[],
  callIds: ReadonlySet<string>,
): string | undefined {
  const invocationByCallId = new Map(invocations.map((invocation) => [invocation.callId, invocation]));
  const effectKeys = new Set<string>();
  for (const effect of ctx.sideEffects ?? []) {
    if (!effect.idempotencyKey || effectKeys.has(effect.idempotencyKey)) {
      return `side effect identity ${effect.idempotencyKey || '(missing)'} is duplicated or missing`;
    }
    effectKeys.add(effect.idempotencyKey);
    if (UNSETTLED_EFFECT_STATUSES.has(effect.status)) {
      return `side effect ${effect.idempotencyKey} is ${effect.status}`;
    }
    if (!effect.callId) return `side effect ${effect.idempotencyKey} has no tool-call identity`;
    const invocation = invocationByCallId.get(effect.callId);
    if (!callIds.has(effect.callId)) {
      if (!inheritedSettledEffectEvidence(ctx, effect)) {
        return `side effect ${effect.idempotencyKey} has no matching tool invocation`;
      }
      continue;
    }
    if (!invocation || invocation.toolName !== effect.toolName) {
      return `side effect ${effect.idempotencyKey} tool identity does not match its invocation`;
    }
    // Invocation hashes cover the redacted request projection; the effect ledger
    // hashes the schema-normalized execution input. The call id and tool name are
    // the shared identity across those intentionally different projections.
    if (effect.status === 'succeeded' && invocation.status !== 'succeeded') {
      return `side effect ${effect.idempotencyKey} settled successfully but its invocation did not`;
    }
  }
  return undefined;
}

function inheritedSettledEffectEvidence(ctx: RunContext, effect: SideEffectCheckpoint): boolean {
  return Boolean(
    ctx.resumedFromCheckpointId
    && effect.callId
    && (effect.status === 'succeeded' || effect.status === 'failed' || effect.status === 'cancelled'),
  );
}

function providerReplyEvidenceGap(ctx: RunContext): string | undefined {
  const provenance = ctx.replyProvenance;
  if (!ctx.reply?.trim() || provenance?.source !== 'llm') {
    return 'no Provider-authored reply is available';
  }
  const request = ctx.modelRequests?.find((candidate) => candidate.id === provenance.modelRequestId);
  if (!request
    || request.runId !== ctx.runId
    || request.requestIndex !== provenance.modelRequestIndex
    || request.provider !== provenance.provider
    || request.model !== provenance.model
    || request.callContract?.purpose !== provenance.purpose) {
    return 'Provider reply provenance does not match a recorded request';
  }
  return undefined;
}

function recordedExecutionFailures(
  invocations: readonly ToolInvocationRecord[],
  sideEffects: readonly SideEffectCheckpoint[],
): string[] {
  const failures: string[] = [];
  for (const invocation of invocations) {
    if (RECORDED_FAILURE_STATUSES.has(invocation.status)) {
      failures.push(`tool invocation ${invocation.callId} is ${invocation.status}`);
    }
  }
  for (const effect of sideEffects) {
    if (effect.status === 'failed' || effect.status === 'cancelled') {
      failures.push(`side effect ${effect.idempotencyKey} is ${effect.status}`);
    }
  }
  return failures.slice(0, 5);
}

function completeEvidenceReason(chinese: boolean): string {
  return chinese
    ? 'Runtime 已确认本次运行的调用、结果、副作用结算和回复来源证据完整；这不等于用户目标已验收完成。'
    : 'Runtime confirmed the run evidence is complete and consistent; this does not establish that the user task objective is complete.';
}

function knownFailureReason(failures: readonly string[], chinese: boolean): string {
  const detail = failures.slice(0, 3).join('; ');
  const more = failures.length > 3 ? ` (+${failures.length - 3})` : '';
  return chinese
    ? `Runtime 保留了已知执行结果（${detail}${more}）；运行证据完整，但用户目标仍未因此获得验收。`
    : `Runtime preserved known execution outcomes (${detail}${more}); the evidence is complete, but the user task objective is not thereby accepted.`;
}

function inboundText(ctx: RunContext): string {
  return ctx.inbound.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function gap(reason: string): RuntimeEvidenceAssessment {
  return { kind: 'gap', reason };
}
