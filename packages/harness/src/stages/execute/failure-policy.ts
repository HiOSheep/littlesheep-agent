import type {
  AgentTool,
  PlanStep,
  TaskBook,
  TaskStepFailureKind,
  TaskStepResult,
  ToolResult,
} from '@littlesheep/types';

export function resolveStepId(step: PlanStep, index: number): string {
  return step.id ?? `step-${index + 1}`;
}

export function pickStepTools(step: PlanStep, tools: AgentTool[]): AgentTool[] {
  if (!step.tools) return tools;
  const names = new Set(step.tools);
  return tools.filter((tool) => names.has(tool.name));
}

/**
 * Tools declared by any step of the plan. Using the union for every step keeps the
 * provider tool block identical across the steps of a run, so a cached prefix is
 * not invalidated by a per-step subset, while the constraint still comes from the
 * plan rather than from the full tool set.
 */
export function pickPlanTools(plan: readonly PlanStep[] | undefined, tools: AgentTool[]): AgentTool[] {
  const names = new Set<string>();
  for (const step of plan ?? []) {
    for (const name of step.tools ?? []) names.add(name);
  }
  if (names.size === 0) return tools;
  return tools.filter((tool) => names.has(tool.name));
}
export function hasBlockingToolFailure(results: ToolResult[]): boolean {
  let lastFailureIndex = -1;
  for (let index = results.length - 1; index >= 0; index--) {
    if (!results[index]!.ok) {
      lastFailureIndex = index;
      break;
    }
  }
  if (lastFailureIndex < 0) return false;
  return !results.slice(lastFailureIndex + 1).some((result) => result.ok);
}

export function blockingToolFailureReason(results: ToolResult[]): string {
  return [...results].reverse().find((result) => !result.ok)?.error
    ?? 'tool failed without a reported reason';
}

export function classifyStepFailure(error: string | undefined, results: ToolResult[]): TaskStepFailureKind {
  // A tool that declares a precise reason wins over text matching: the refusal
  // wording for a stale or missing file observation must not be mistaken for a
  // permission problem just because it says the write was refused.
  const declaredKinds = results
    .filter((result) => !result.ok)
    .map((result) => (result.meta as Record<string, unknown> | undefined)?.['errorKind'])
    .filter((kind): kind is string => typeof kind === 'string');
  if (declaredKinds.length > 0
    && declaredKinds.every((kind) => kind.startsWith('observation_') || kind === 'target_exists')) {
    return 'tool_error';
  }
  const text = [error, ...results.filter((result) => !result.ok).map((result) => result.error)]
    .filter((value): value is string => !!value)
    .join(' ')
    .toLowerCase();
  if (/denied|approval|permission/.test(text)) return 'permission_denied';
  if (/enoent|not found|cannot find|does not exist|no such file/.test(text)) return 'not_found';
  if (/abort|cancelled|canceled/.test(text)) return 'aborted';
  if (/llm call|finishreason|tool loop exceeded|model/.test(text)) return 'model_error';
  if (results.some((result) => !result.ok)) return 'tool_error';
  return 'unknown';
}

export function orderedStepResults(
  taskBook: TaskBook,
  results: Map<string, TaskStepResult>,
): TaskStepResult[] {
  return taskBook.steps
    .map((step, index) => results.get(resolveStepId(step, index)))
    .filter((result): result is TaskStepResult => !!result);
}
