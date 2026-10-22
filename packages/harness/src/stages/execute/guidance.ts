import type { ChatMessage } from '@littlesheep/llm';
import type {
  PlanStep,
  RunContext,
  TaskBook,
} from '@littlesheep/types';
import {
  attachmentContextMessages,
  textOf,
  toChatMessage,
  userChatMessage,
} from '../_shared.js';
import { modelHistoryMessages } from '../../model-history.js';

export function renderPlanGuidance(plan: PlanStep[]): string {
  const lines = plan.map((step, index) => {
    const tools = step.tools && step.tools.length > 0 ? ` [tools: ${step.tools.join(', ')}]` : '';
    const approval = step.requiresApproval ? ' (needs approval)' : '';
    return `${index + 1}. ${step.description}${tools}${approval}`;
  });
  return `Proposed plan:\n${lines.join('\n')}`;
}

export function renderTaskBookGuidance(taskBook: TaskBook): string {
  const criteria = taskBook.successCriteria.length > 0
    ? taskBook.successCriteria.map((item) => `- ${item}`).join('\n')
    : '- Satisfy the calibrated user goal.';
  const lines = taskBook.steps.map((step, index) => {
    const label = step.title ? `${step.title}: ` : '';
    const tools = step.tools && step.tools.length > 0 ? ` [tools: ${step.tools.join(', ')}]` : '';
    const approval = step.requiresApproval ? ' (needs approval)' : '';
    const stepCriteria = step.acceptanceCriteria && step.acceptanceCriteria.length > 0
      ? `\n     acceptance: ${step.acceptanceCriteria.join('; ')}`
      : '';
    const expected = step.expectedOutput ? `\n     expected: ${step.expectedOutput}` : '';
    const scheduling = renderScheduling(step);
    return `${index + 1}. ${label}${step.description}${tools}${approval}${scheduling}${stepCriteria}${expected}`;
  });
  return `Task book:
Goal: ${taskBook.goal}
Complexity: ${taskBook.complexity}
Overdelivery limit: ${taskBook.overdeliveryPolicy.maxExtraScopeRatio}x
Overdelivery guidance: ${taskBook.overdeliveryPolicy.guidance}
Success criteria:
${criteria}

Steps:
${lines.join('\n')}

Execution rules:
- Keep work proportional to the calibrated complexity.
- Do not exceed the overdelivery limit; avoid doing broad extra work unless it directly improves the goal.
- When the task is trivial/simple, prefer the shortest sufficient route.
- When evidence is needed, use tools to verify before claiming success.`;
}

function renderScheduling(step: PlanStep): string {
  if (!step.execution) return '';
  const dependencies = step.execution.dependsOn?.length
    ? `; after: ${step.execution.dependsOn.join(', ')}`
    : '';
  return ` [${step.execution.mode}; effect: ${step.execution.sideEffect ?? 'unspecified'}${dependencies}]`;
}

export function buildBaseMessages(
  ctx: RunContext,
  systemMessage: string,
  attachments: ReturnType<typeof attachmentContextMessages>,
  history?: RunContext['history'],
): ChatMessage[] {
  const historyMessages = history ? history.map(toChatMessage) : modelHistoryMessages(ctx);
  return [
    { role: 'system', content: systemMessage },
    ...historyMessages,
    ...attachments.map((item) => item.message),
    userChatMessage(textOf(ctx.inbound), ctx.attachments),
  ];
}
