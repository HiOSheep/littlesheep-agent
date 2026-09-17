import type { ToolSpec } from '@littlesheep/llm';
import type {
  RunContext,
  StageResult,
  ToolResult,
  WorkPolicyUpgradeRequest,
} from '@littlesheep/types';
import { resolveExecutionWorkPolicy } from './lean-work-policy.js';

export const WORK_POLICY_UPGRADE_TOOL_NAME = 'request_task_book';

export interface WorkPolicyUpgradeProposal {
  reasonCode: WorkPolicyUpgradeRequest['reasonCode'];
  reason: string;
  remainingGoal: string;
}

const REASON_CODES: readonly WorkPolicyUpgradeRequest['reasonCode'][] = [
  'dependency_discovered',
  'scope_expanded',
  'acceptance_gap',
  'long_running',
  'budget_pressure',
];

export function workPolicyUpgradeToolSpec(): ToolSpec {
  return {
    type: 'function',
    function: {
      name: WORK_POLICY_UPGRADE_TOOL_NAME,
      description: 'Stop the bounded work loop and request a TaskBook for newly discovered dependencies, scope, acceptance, duration, or budget pressure. Call this control alone; it performs no user tool action.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['reasonCode', 'reason', 'remainingGoal'],
        properties: {
          reasonCode: { type: 'string', enum: [...REASON_CODES] },
          reason: { type: 'string', minLength: 1, maxLength: 1_024 },
          remainingGoal: { type: 'string', minLength: 1, maxLength: 2_000 },
        },
      },
    },
  };
}

export function parseWorkPolicyUpgradeProposal(value: unknown): WorkPolicyUpgradeProposal | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.some((key) => key !== 'reasonCode' && key !== 'reason' && key !== 'remainingGoal')) return undefined;
  if (!REASON_CODES.includes(candidate.reasonCode as WorkPolicyUpgradeProposal['reasonCode'])) return undefined;
  if (typeof candidate.reason !== 'string') return undefined;
  const reason = candidate.reason.trim();
  if (!reason || reason.length > 1_024) return undefined;
  if (typeof candidate.remainingGoal !== 'string') return undefined;
  const remainingGoal = candidate.remainingGoal.trim();
  if (!remainingGoal || remainingGoal.length > 2_000) return undefined;
  return { reasonCode: candidate.reasonCode as WorkPolicyUpgradeProposal['reasonCode'], reason, remainingGoal };
}

export function buildWorkPolicyUpgradeRequest(
  ctx: RunContext,
  proposal: WorkPolicyUpgradeProposal,
  toolResults: readonly ToolResult[],
): WorkPolicyUpgradeRequest {
  const policy = resolveExecutionWorkPolicy(ctx);
  if (policy.executionMode !== 'bounded_loop') throw new Error('only a bounded loop can request TaskBook promotion');
  if (ctx.workPolicyUpgradeRequest) throw new Error('this goal has already requested TaskBook promotion');
  if ((ctx.sideEffects ?? []).some((effect) => effect.status === 'planned'
    || effect.status === 'in_progress' || effect.status === 'unknown')) {
    throw new Error('cannot promote while a side effect is pending or unknown');
  }
  const pendingToolCallIds = (ctx.toolInvocations ?? [])
    .filter((record) => record.status === 'proposed'
      || record.status === 'running')
    .map((record) => record.callId);
  if (pendingToolCallIds.length > 0) throw new Error('cannot promote while a tool invocation is pending');
  const modelAttemptsUsed = Math.max(ctx.modelCallCount ?? 0, ctx.modelRequests?.length ?? 0);
  const toolLoopIterationsUsed = ctx.loopBudget?.toolLoopIterationsUsed ?? 0;
  return {
    version: 1,
    id: `${ctx.runId}:work-policy-upgrade:1`,
    runId: ctx.runId,
    sourceMessageId: policy.sourceMessageId,
    goalVersion: 1,
    requestedAt: (ctx.runtimeNow?.() ?? new Date()).toISOString(),
    reasonCode: proposal.reasonCode,
    reason: proposal.reason,
    remainingGoal: proposal.remainingGoal,
    completedToolCallIds: [...new Set(toolResults.filter((result) => result.ok).map((result) => result.callId))].slice(-128),
    pendingToolCallIds: [],
    completedEffectRefs: (ctx.sideEffects ?? [])
      .filter((effect): effect is typeof effect & { status: 'succeeded' | 'failed' | 'cancelled' } => (
        effect.status === 'succeeded' || effect.status === 'failed' || effect.status === 'cancelled'
      ))
      .slice(-128)
      .map((effect) => ({
        idempotencyKey: effect.idempotencyKey,
        status: effect.status,
        ...(effect.callId ? { callId: effect.callId } : {}),
      })),
    modelAttemptsUsed,
    budget: {
      maxModelAttempts: ctx.maxModelCalls ?? ctx.loopBudget?.maxAttempts ?? 0,
      toolLoopIterationsUsed,
      maxToolLoopIterations: ctx.loopBudget?.maxToolLoopIterations ?? 20,
      noProgressRounds: ctx.loopBudget?.noProgressRounds ?? 0,
    },
  };
}

/** Additional Runtime guard for the otherwise legal execute -> decide edge. */
export function workPolicyTransitionViolation(
  ctx: RunContext,
  from: string,
  result: StageResult,
): string | undefined {
  if (from !== 'execute' || result.next !== 'decide') return undefined;
  const request = ctx.workPolicyUpgradeRequest;
  const metaId = typeof result.meta?.workPolicyUpgradeRequestId === 'string'
    ? result.meta.workPolicyUpgradeRequestId
    : undefined;
  if (!request || request.version !== 1) return 'execute -> decide requires a persisted work-policy upgrade request';
  if (request.runId !== ctx.runId || request.sourceMessageId !== ctx.classification?.workPolicy?.sourceMessageId) {
    return 'work-policy upgrade identity does not match the active run';
  }
  if (metaId !== request.id) return 'stage result does not reference the persisted work-policy upgrade request';
  if (request.pendingToolCallIds.length > 0) return 'work-policy upgrade contains pending tool invocations';
  if ((ctx.sideEffects ?? []).some((effect) => effect.status === 'planned'
    || effect.status === 'in_progress' || effect.status === 'unknown')) {
    return 'work-policy upgrade cannot cross a pending or unknown side effect';
  }
  return undefined;
}
