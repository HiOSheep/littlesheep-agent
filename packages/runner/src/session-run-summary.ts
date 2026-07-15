import type {
  AgentResult,
  Message,
  SessionRunSummary,
  SessionRunToolTiming,
} from '@littlesheep/types';

const MAX_SESSION_TOOL_TIMINGS = 12;

export interface BuildSessionRunSummaryInput {
  runId: string;
  status: AgentResult['status'];
  startedAtMs: number;
  durationMs: number;
  messages: Message[];
  taskExecution?: AgentResult['taskExecution'];
  taskBook?: AgentResult['taskBook'];
}

export function buildSessionRunSummary(input: BuildSessionRunSummaryInput): SessionRunSummary {
  const names = new Map<string, string>();
  const tools: SessionRunToolTiming[] = [];
  for (const message of input.messages) {
    for (const block of message.content) {
      if (block.type === 'tool_calls') {
        for (const call of block.calls) names.set(call.id, call.name);
      } else if (block.type === 'tool_result') {
        tools.push({
          name: names.get(block.result.callId) ?? 'unknown',
          status: block.result.ok ? 'succeeded' : 'failed',
          durationMs: block.result.durationMs,
          stepId: typeof block.result.meta?.stepId === 'string'
            ? block.result.meta.stepId
            : undefined,
        });
      }
    }
  }
  const succeeded = tools.filter((tool) => tool.status === 'succeeded').length;
  const failed = tools.length - succeeded;
  const taskSteps = input.taskExecution?.steps ?? [];
  const totalSteps = input.taskBook?.steps.length ?? taskSteps.length;
  const completedSteps = taskSteps.filter((step) => step.status === 'done' || step.status === 'skipped').length;
  const durationMs = Math.max(0, Math.floor(input.durationMs));

  return {
    version: 1,
    runId: input.runId,
    status: input.status,
    startedAt: new Date(input.startedAtMs).toISOString(),
    endedAt: new Date(input.startedAtMs + durationMs).toISOString(),
    durationMs,
    task: totalSteps > 0
      ? {
          status: input.taskExecution?.status ?? 'pending',
          completedSteps,
          totalSteps,
        }
      : undefined,
    tools: {
      total: tools.length,
      succeeded,
      failed,
      totalDurationMs: tools.reduce((total, tool) => total + (tool.durationMs ?? 0), 0),
      recent: tools.slice(-MAX_SESSION_TOOL_TIMINGS),
      truncated: tools.length > MAX_SESSION_TOOL_TIMINGS,
    },
  };
}
