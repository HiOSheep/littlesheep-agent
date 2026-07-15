import type { RunContext, TaskBook, TaskStepResult } from '@littlesheep/types';
import { buildRunRequestCandidates } from '../../context-candidates.js';
import { prepareModelRequest, recordProviderUsage } from '../../model-observability.js';
import { appendSystemPromptAddons } from '../../profile-prompt.js';
import { textOf } from '../_shared.js';
import type { ExecuteStageDeps } from './contracts.js';
import { applyUsage } from './tool-loop.js';

export async function synthesizeFinalReply(
  deps: ExecuteStageDeps,
  ctx: RunContext,
  taskBook: TaskBook,
  stepResults: TaskStepResult[],
): Promise<string> {
  if (stepResults.length === 1) return stepResults[0]?.output ?? '';

  const stepSummary = stepResults.map((step, index) =>
    `${index + 1}. ${step.title ?? step.stepId} [${step.status}]\n`
    + `Description: ${step.description}\n`
    + `Output: ${step.output ?? '(no output)'}\n`
    + (step.error ? `Error: ${step.error}\n` : ''),
  ).join('\n');

  try {
    const rawRequest = {
      model: deps.model,
      messages: [
        {
          role: 'system',
          content: appendSystemPromptAddons(
            `You are the final response assembler. Produce the final user-facing answer from completed task-book step results.
Follow progressive disclosure: lead with the outcome and completion status, then give key results, artifacts, evidence, and the next action only when useful. Keep detail proportional to the user's request; simple tasks should not become reports. Do not dump raw command output or private chain-of-thought. Never hide failed or partial steps, permission denials, risks, uncertainty, external side effects, or decisions required from the user. Do not claim failed steps succeeded.`,
            ctx.profilePromptAddon,
            ctx.reasoningPromptAddon,
          ),
        },
        {
          role: 'user',
          content:
            `Original request:\n${textOf(ctx.inbound)}\n\n`
            + `Task goal:\n${taskBook.goal}\n\n`
            + `Success criteria:\n${taskBook.successCriteria.map((item) => `- ${item}`).join('\n')}\n\n`
            + `Step results:\n${stepSummary}\n\n`
            + `Write the final reply in the user's language.`,
        },
      ],
      temperature: 0,
      max_tokens: 900,
      signal: ctx.signal,
    } satisfies import('@littlesheep/llm').ChatRequest;
    const request = prepareModelRequest(
      ctx,
      'execute_final_reply',
      rawRequest,
      buildRunRequestCandidates(ctx, 'execute', rawRequest.messages, {
        history: [],
        primaryUserKind: 'workflow_state',
      }),
    );
    const response = await deps.llm.chat(request);
    recordProviderUsage(ctx, request, response.usage);
    applyUsage(ctx, response.usage);
    return response.content.trim() || stepResults.map((step) => step.output).filter(Boolean).join('\n\n');
  } catch {
    return stepResults
      .map((step) => step.output)
      .filter((output): output is string => !!output && output.trim().length > 0)
      .join('\n\n');
  }
}
