import type { RunContext, ToolResult } from '@littlesheep/types';

export function buildVerifyUserMessage(ctx: RunContext, replanAttempts: number, maxReplan: number): string {
  return `Original goal (inbound):\n${truncate(inboundText(ctx), 800)}\n\n`
    + `Execution contract:\n${describeTaskContract(ctx)}\n\n`
    + `Step execution results:\n${describeTaskExecution(ctx)}\n\n`
    + `Tool results (${(ctx.toolResults ?? []).length} call(s)):\n${summarizeToolResults(ctx.toolResults ?? [])}\n\n`
    + `Drafted reply:\n${truncate(ctx.reply ?? '(no reply)', 800)}\n\n`
    + `Replan attempts: ${replanAttempts}/${maxReplan}\n\n`
    + 'Return your verdict.';
}

function inboundText(ctx: RunContext): string {
  return ctx.inbound.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function summarizeToolResults(results: ToolResult[]): string {
  if (results.length === 0) return '(no tool calls)';
  return results.map((result, index) => {
    const status = result.ok ? 'ok' : `error: ${result.error ?? 'unknown'}`;
    const output = result.ok && result.output !== undefined
      ? truncate(JSON.stringify(result.output), 400)
      : '';
    return `  ${index + 1}. ${status}${output ? `\n     output: ${output}` : ''}`;
  }).join('\n');
}

function describeTaskContract(ctx: RunContext): string {
  if (ctx.taskBook) {
    const taskBook = ctx.taskBook;
    const criteria = taskBook.successCriteria.length > 0
      ? taskBook.successCriteria.map((item) => `  - ${item}`).join('\n')
      : '  - (none)';
    const steps = taskBook.steps.map((step, index) => {
      const tools = step.tools ? ` (tools: ${step.tools.join(', ')})` : '';
      const acceptance = step.acceptanceCriteria && step.acceptanceCriteria.length > 0
        ? `\n     acceptance: ${step.acceptanceCriteria.join('; ')}`
        : '';
      return `  ${index + 1}. ${step.description}${tools}${acceptance}`;
    }).join('\n');
    return `Task book:
Goal: ${taskBook.goal}
Complexity: ${taskBook.complexity}
Overdelivery limit: ${taskBook.overdeliveryPolicy.maxExtraScopeRatio}x
Success criteria:
${criteria}
Steps:
${steps || '  (none)'}`;
  }
  return ctx.plan && ctx.plan.length > 0
    ? ctx.plan.map((step, index) => `  ${index + 1}. ${step.description}${step.tools ? ` (tools: ${step.tools.join(', ')})` : ''}`).join('\n')
    : '(no plan)';
}

function describeTaskExecution(ctx: RunContext): string {
  if (!ctx.taskExecution) return '(no step execution result)';
  const execution = ctx.taskExecution;
  const steps = execution.steps.map((step, index) => {
    const criteria = step.acceptanceCriteria && step.acceptanceCriteria.length > 0
      ? `\n     acceptance: ${step.acceptanceCriteria.join('; ')}`
      : '';
    const output = step.output ? `\n     output: ${truncate(step.output, 500)}` : '';
    const error = step.error ? `\n     error: ${step.error}` : '';
    return `  ${index + 1}. ${step.title ?? step.stepId} [${step.status}]${criteria}\n     tool calls: ${step.toolCallIds.length}${output}${error}`;
  }).join('\n');
  return `Task execution:
Status: ${execution.status}
Summary: ${execution.summary ? truncate(execution.summary, 500) : '(none yet)'}
Steps:
${steps || '  (none)'}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max) + '...[truncated]';
}
