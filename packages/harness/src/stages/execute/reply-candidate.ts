import { createHash } from 'node:crypto';
import type {
  RunContext,
  TaskBook,
  TaskStepReplyCandidate,
  TaskStepResult,
  ToolResult,
} from '@littlesheep/types';

export function createTaskStepReplyCandidate(
  ctx: RunContext,
  taskBook: TaskBook,
  result: TaskStepResult,
  modelRequestId: string | undefined,
): TaskStepReplyCandidate | undefined {
  if (!modelRequestId || !result.output?.trim() || result.error || result.status !== 'done') return undefined;
  const request = ctx.modelRequests?.find((candidate) => candidate.id === modelRequestId);
  if (!request || request.runId !== ctx.runId || request.callContract?.purpose !== 'execute_tool_loop') return undefined;
  const coversGoal = taskBook.steps.length === 1
    && (taskBook.complexity === 'trivial' || taskBook.complexity === 'simple');
  return {
    version: 1,
    source: 'llm',
    purpose: 'execute_tool_loop',
    runId: ctx.runId,
    modelRequestId,
    goalVersion: ctx.workPolicyUpgradeRequest?.goalVersion ?? 1,
    goalFingerprint: taskGoalFingerprint(taskBook),
    evidenceRevision: taskEvidenceRevision(result.toolResults),
    coversGoal,
    generatedAt: request.createdAt,
  };
}

export function reusableTaskStepReplyCandidate(
  ctx: RunContext,
  taskBook: TaskBook,
  result: TaskStepResult,
): TaskStepReplyCandidate | undefined {
  const candidate = result.replyCandidate;
  if (!candidate || candidate.version !== 1 || candidate.source !== 'llm') return undefined;
  if (!candidate.coversGoal || candidate.runId !== ctx.runId || candidate.purpose !== 'execute_tool_loop') return undefined;
  if (candidate.goalVersion !== (ctx.workPolicyUpgradeRequest?.goalVersion ?? 1)) return undefined;
  if (candidate.goalFingerprint !== taskGoalFingerprint(taskBook)) return undefined;
  if (candidate.evidenceRevision !== taskEvidenceRevision(result.toolResults)) return undefined;
  const request = ctx.modelRequests?.find((snapshot) => snapshot.id === candidate.modelRequestId);
  if (!request || request.runId !== ctx.runId || request.callContract?.purpose !== candidate.purpose) return undefined;
  if (result.status !== 'done' || result.error || result.toolResults.some((tool) => !tool.ok)) return undefined;
  return candidate;
}

function taskGoalFingerprint(taskBook: TaskBook): string {
  return hash(JSON.stringify({
    goal: taskBook.goal,
    successCriteria: taskBook.successCriteria,
    steps: taskBook.steps.map((step) => ({
      id: step.id,
      description: step.description,
      acceptanceCriteria: step.acceptanceCriteria,
    })),
  }));
}

function taskEvidenceRevision(results: readonly ToolResult[]): string {
  return hash(JSON.stringify(results.map((result) => ({
    callId: result.callId,
    ok: result.ok,
    output: result.output,
    error: result.error,
    sanitized: result.sanitized,
    meta: result.meta,
  }))));
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
