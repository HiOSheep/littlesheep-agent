// @littlesheep/harness - stages/verify.ts
// VERIFY: LLM judges whether EXECUTE achieved the calibrated task contract.
// Verdicts:
//   pass         -> EVOLVE
//   needs_replan -> DECIDE with concrete feedback
//   fail         -> RECOVER

import type {
  PartialReplanRequest,
  RunContext,
  StageResult,
  TaskStepFailureKind,
  ToolResult,
  VerificationRecord,
} from '@littlesheep/types';
import type { LlmClient, ChatMessage } from '@littlesheep/llm';
import { appendSystemPromptAddons } from '../profile-prompt.js';
import { prepareModelRequest, recordProviderUsage } from '../model-observability.js';
import { buildRunRequestCandidates } from '../context-candidates.js';
import { textOf, callLlmForJson } from './_shared.js';

export interface VerifyStageDeps {
  llm: LlmClient;
  model: string;
}

const SYSTEM_PROMPT = `You are the VERIFY stage of a hard-control-flow agent.
Your job is to judge whether the run achieved the user's calibrated goal,
based on the task book/plan, per-step execution results, tool results, and drafted reply.

Return ONLY a JSON object, no markdown:
{"verdict":"pass"|"needs_replan"|"fail","reason":"short explanation","feedback":"optional guidance for re-planning","failedStepIds":["step-id"]}

Verdict rules:
- "pass": the goal is achieved. Tool results positively confirm success AND
  the reply coherently addresses the inbound and success criteria. Absence of
  errors is NOT enough - require positive evidence.
- "needs_replan": the goal is NOT achieved, but the failed/incomplete steps can
  be revised while preserving completed evidence. This includes recoverable
  tool/path errors. List the exact failedStepIds and concrete feedback.
- "fail": execution infrastructure, model transport, permission refusal, abort,
  or another condition that cannot be fixed by revising task steps.

Strict but fair. If the reply claims success but tool results don't confirm
it, return "needs_replan" with feedback pointing out the gap. If a tool
errored, distinguish a recoverable step problem from an infrastructure failure.
Never call tools - you only judge.`;

interface DecodedVerdict {
  verdict?: string;
  reason?: string;
  feedback?: string;
  failedStepIds?: unknown;
}

function resolvedStepId(step: { id?: string }, index: number): string {
  return step.id ?? `step-${index + 1}`;
}

function taskStepIds(ctx: RunContext): string[] {
  return ctx.taskBook?.steps.map((step, index) => resolvedStepId(step, index)) ?? [];
}

function deriveReplanTargets(ctx: RunContext, requested: unknown): string[] {
  const knownIds = taskStepIds(ctx);
  const known = new Set(knownIds);
  const explicit = Array.isArray(requested)
    ? requested.filter((id): id is string => typeof id === 'string' && known.has(id))
    : [];
  if (explicit.length > 0) return [...new Set(explicit)];

  const results = new Map((ctx.taskExecution?.steps ?? []).map((step) => [step.stepId, step]));
  const incomplete = knownIds.filter((id) => results.get(id)?.status !== 'done');
  if (incomplete.length > 0) return incomplete;
  return knownIds.length > 0 ? [knownIds[knownIds.length - 1]!] : [];
}

function failedKinds(ctx: RunContext, targetIds: string[]): TaskStepFailureKind[] {
  const targets = new Set(targetIds);
  return (ctx.taskExecution?.steps ?? [])
    .filter((step) => targets.has(step.stepId) && step.failureKind)
    .map((step) => step.failureKind!);
}

function canRecoverWithPartialReplan(ctx: RunContext, targetIds: string[]): boolean {
  if (!ctx.taskBook || targetIds.length === 0) return false;
  const kinds = failedKinds(ctx, targetIds);
  if (kinds.some((kind) => kind === 'permission_denied' || kind === 'model_error' || kind === 'aborted')) {
    return false;
  }
  return kinds.length === 0
    || kinds.some((kind) => kind === 'tool_error'
      || kind === 'not_found'
      || kind === 'verification_gap'
      || kind === 'unknown');
}

function hasIncompleteTaskExecution(ctx: RunContext): boolean {
  if (!ctx.taskBook || !ctx.taskExecution) return false;
  const results = new Map(ctx.taskExecution.steps.map((step) => [step.stepId, step.status]));
  return taskStepIds(ctx).some((id) => results.get(id) !== 'done');
}

function installPartialReplan(
  ctx: RunContext,
  targetStepIds: string[],
  reason: string,
  feedback: string,
  attempt: number,
): PartialReplanRequest {
  const request: PartialReplanRequest = {
    attempt,
    requestedAt: new Date().toISOString(),
    targetStepIds,
    reason,
    feedback,
  };
  const targets = new Set(targetStepIds);
  const completed = new Set(
    (ctx.taskExecution?.steps ?? [])
      .filter((step) => step.status === 'done')
      .map((step) => step.stepId),
  );
  const preservedStepIds = taskStepIds(ctx).filter((id) => completed.has(id) && !targets.has(id));
  ctx.partialReplanRequest = request;
  ctx.replanHistory = [
    ...(ctx.replanHistory ?? ctx.taskExecution?.replanHistory ?? []),
    { ...request, preservedStepIds },
  ];
  if (ctx.taskExecution) ctx.taskExecution.replanHistory = ctx.replanHistory;
  return request;
}

function usesChinese(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text);
}

function recordVerification(ctx: RunContext, record: Omit<VerificationRecord, 'attempt' | 'verifiedAt'>): VerificationRecord {
  const verification: VerificationRecord = {
    ...record,
    attempt: (ctx.verificationHistory?.length ?? 0) + 1,
    verifiedAt: new Date().toISOString(),
  };
  ctx.verificationHistory = [...(ctx.verificationHistory ?? []), verification];
  ctx.onToolEvent?.({ type: 'verification', verification });
  return verification;
}

function publishVerifiedReply(ctx: RunContext): void {
  if (!ctx.reply) return;
  ctx.onToolEvent?.({ type: 'final_delta', output: ctx.reply });
  ctx.onAssistantDelta?.(ctx.reply);
}

function escalateExhaustedReplan(ctx: RunContext, reason: string, feedback: string): StageResult {
  const originalRequest = textOf(ctx.inbound);
  const chinese = usesChinese(originalRequest);
  ctx.partialReplanRequest = undefined;
  ctx.clarificationRequest = {
    id: `${ctx.runId}:clarification`,
    kind: 'recovery_decision',
    sourceStage: 'verify',
    createdAt: new Date().toISOString(),
    originalRequest,
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

function routeKnownIncompleteExecution(
  ctx: RunContext,
  replanAttempts: number,
  maxReplan: number,
  reason: string,
  meta: Record<string, unknown>,
): StageResult {
  if (!hasIncompleteTaskExecution(ctx)) {
    recordVerification(ctx, {
      verdict: 'pass',
      reason,
      source: 'degraded',
    });
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
  if (replanAttempts >= maxReplan) {
    return escalateExhaustedReplan(ctx, reason, feedback);
  }

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

/** Compress toolResults into an LLM-readable summary (each output capped at 400 chars). */
function summarizeToolResults(results: ToolResult[]): string {
  if (results.length === 0) return '(no tool calls)';
  return results
    .map((r, i) => {
      const status = r.ok ? 'ok' : `error: ${r.error ?? 'unknown'}`;
      const out =
        r.ok && r.output !== undefined
          ? truncate(JSON.stringify(r.output), 400)
          : '';
      return `  ${i + 1}. ${status}${out ? `\n     output: ${out}` : ''}`;
    })
    .join('\n');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '...[truncated]';
}

function describeTaskContract(ctx: RunContext): string {
  if (ctx.taskBook) {
    const tb = ctx.taskBook;
    const criteria = tb.successCriteria.length > 0
      ? tb.successCriteria.map((c) => `  - ${c}`).join('\n')
      : '  - (none)';
    const steps = tb.steps.map((p, i) => {
      const tools = p.tools ? ` (tools: ${p.tools.join(', ')})` : '';
      const acceptance = p.acceptanceCriteria && p.acceptanceCriteria.length > 0
        ? `\n     acceptance: ${p.acceptanceCriteria.join('; ')}`
        : '';
      return `  ${i + 1}. ${p.description}${tools}${acceptance}`;
    }).join('\n');
    return `Task book:
Goal: ${tb.goal}
Complexity: ${tb.complexity}
Overdelivery limit: ${tb.overdeliveryPolicy.maxExtraScopeRatio}x
Success criteria:
${criteria}
Steps:
${steps || '  (none)'}`;
  }

  return ctx.plan && ctx.plan.length > 0
    ? ctx.plan.map((p, i) => `  ${i + 1}. ${p.description}${p.tools ? ` (tools: ${p.tools.join(', ')})` : ''}`).join('\n')
    : '(no plan)';
}

function describeTaskExecution(ctx: RunContext): string {
  if (!ctx.taskExecution) return '(no step execution result)';
  const execution = ctx.taskExecution;
  const steps = execution.steps.map((step, i) => {
    const criteria = step.acceptanceCriteria && step.acceptanceCriteria.length > 0
      ? `\n     acceptance: ${step.acceptanceCriteria.join('; ')}`
      : '';
    const output = step.output ? `\n     output: ${truncate(step.output, 500)}` : '';
    const error = step.error ? `\n     error: ${step.error}` : '';
    const toolCalls = `\n     tool calls: ${step.toolCallIds.length}`;
    return `  ${i + 1}. ${step.title ?? step.stepId} [${step.status}]${criteria}${toolCalls}${output}${error}`;
  }).join('\n');
  return `Task execution:
Status: ${execution.status}
Summary: ${execution.summary ? truncate(execution.summary, 500) : '(none yet)'}
Steps:
${steps || '  (none)'}`;
}

/** Factory: creates a verify stage. */
export function createVerifyStage(deps: VerifyStageDeps) {
  return async function verifyStage(ctx: RunContext): Promise<StageResult> {
    const replanAttempts = ctx.replanAttempts ?? 0;
    const maxReplan = ctx.maxReplanAttempts ?? 2;
    ctx.onToolEvent?.({ type: 'verification_start' });

    const userMsg =
      `Original goal (inbound):\n${truncate(textOf(ctx.inbound), 800)}\n\n`
      + `Execution contract:\n${describeTaskContract(ctx)}\n\n`
      + `Step execution results:\n${describeTaskExecution(ctx)}\n\n`
      + `Tool results (${(ctx.toolResults ?? []).length} call(s)):\n${summarizeToolResults(ctx.toolResults ?? [])}\n\n`
      + `Drafted reply:\n${truncate(ctx.reply ?? '(no reply)', 800)}\n\n`
      + `Replan attempts: ${replanAttempts}/${maxReplan}\n\n`
      + `Return your verdict.`;

    const messages: ChatMessage[] = [
      { role: 'system', content: appendSystemPromptAddons(SYSTEM_PROMPT, ctx.profilePromptAddon) },
      { role: 'user', content: userMsg },
    ];

    let parsed: DecodedVerdict | null;
    try {
      ({ parsed } = await callLlmForJson<DecodedVerdict>(
        deps.llm,
        deps.model,
        messages,
        {
          maxAttempts: 2,
          maxTokens: 500,
          signal: ctx.signal,
          onRequest: (request) => prepareModelRequest(
            ctx,
            'verify',
            request,
            buildRunRequestCandidates(ctx, 'verify', request.messages, {
              history: [],
              primaryUserKind: 'workflow_state',
            }),
          ),
          onResponse: (request, response) => recordProviderUsage(ctx, request, response.usage),
        },
      ));
    } catch (e) {
      return routeKnownIncompleteExecution(
        ctx,
        replanAttempts,
        maxReplan,
        `verifier transport error: ${(e as Error).message}`,
        { transportError: (e as Error).message },
      );
    }

    if (!parsed || (parsed.verdict !== 'pass' && parsed.verdict !== 'needs_replan' && parsed.verdict !== 'fail')) {
      return routeKnownIncompleteExecution(
        ctx,
        replanAttempts,
        maxReplan,
        'verdict decode failed',
        { decodeFailure: true },
      );
    }

    if (parsed.verdict === 'pass') {
      if (hasIncompleteTaskExecution(ctx)) {
        return routeKnownIncompleteExecution(
          ctx,
          replanAttempts,
          maxReplan,
          'verifier returned pass despite failed or missing step evidence',
          { structuralOverride: true },
        );
      }
      recordVerification(ctx, {
        verdict: 'pass',
        reason: parsed.reason ?? 'Task contract satisfied.',
        source: 'model',
      });
      publishVerifiedReply(ctx);
      return {
        stage: 'verify',
        next: 'evolve',
        ok: true,
        meta: { verdict: 'pass', reason: parsed.reason, replanAttempts },
      };
    }

    const targetStepIds = deriveReplanTargets(ctx, parsed.failedStepIds);
    const shouldPartialReplan = parsed.verdict === 'needs_replan'
      || (parsed.verdict === 'fail' && canRecoverWithPartialReplan(ctx, targetStepIds));

    if (parsed.verdict === 'fail' && !shouldPartialReplan) {
      ctx.lastError = {
        stage: 'verify',
        message: `verify failed: ${parsed.reason ?? 'tool error detected'}`,
      };
      recordVerification(ctx, {
        verdict: 'fail',
        reason: parsed.reason ?? 'Tool error detected.',
        failedStepIds: targetStepIds,
        source: 'model',
      });
      return {
        stage: 'verify',
        next: 'recover',
        ok: false,
        error: ctx.lastError.message,
        meta: { verdict: 'fail', reason: parsed.reason, failedStepIds: targetStepIds },
      };
    }

    const reason = parsed.reason ?? 'previous plan did not achieve the goal';
    const feedback = parsed.feedback ?? reason;
    if (replanAttempts >= maxReplan) {
      return escalateExhaustedReplan(ctx, reason, feedback);
    }

    ctx.replanAttempts = replanAttempts + 1;
    ctx.verifyFeedback = feedback;
    if (ctx.taskBook && targetStepIds.length > 0) {
      installPartialReplan(ctx, targetStepIds, reason, feedback, ctx.replanAttempts);
    }
    recordVerification(ctx, {
      verdict: 'needs_replan',
      reason,
      feedback,
      failedStepIds: targetStepIds,
      source: 'model',
    });
    return {
      stage: 'verify',
      next: 'decide',
      ok: true,
      meta: {
        verdict: 'needs_replan',
        reason: parsed.reason,
        feedback: ctx.verifyFeedback,
        failedStepIds: targetStepIds,
        replanAttempts: ctx.replanAttempts,
      },
    };
  };
}
