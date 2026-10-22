import type { TaskStepFailureKind, ToolResult } from '@littlesheep/types';

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
