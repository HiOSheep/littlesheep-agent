import type { RunContext, TaskBook, TaskStepResult, WebEvidenceProjection } from '@littlesheep/types';
import { buildRunRequestCandidates } from '../../context-candidates.js';
import {
  preferDirectModelOutput,
  prepareModelRequest,
  callModelChat,
  callModelChatStream,
} from '../../model-observability.js';
import {
  appendSystemPromptAddons,
  buildCompactBehaviorProfileAddon,
  buildCompactUserFacingVoiceAddon,
  buildUserFacingVoiceAddon,
} from '../../profile-prompt.js';
import { textOf } from '../_shared.js';
import type { ExecuteStageDeps } from './contracts.js';
import { publishUserFacingReply } from '../../user-facing-reply.js';
import { isCompactReadOnlyResult } from '../../compact-read-only-result.js';
import { validateWebCitations, webCitationRepairContract } from '../../web-citation-validation.js';

const MAX_WEB_CITATION_REPAIRS = 2;

export async function synthesizeFinalReply(
  deps: ExecuteStageDeps,
  ctx: RunContext,
  taskBook: TaskBook,
  stepResults: TaskStepResult[],
  replyStage: 'execute' | 'reply' = 'execute',
): Promise<string> {
  const compact = isCompactReadOnlyResult(ctx, taskBook, stepResults);
  const stepSummary = stepResults.map((step, index) =>
    `${index + 1}. ${step.title ?? step.stepId} [${step.status}]\n`
    + `Description: ${step.description}\n`
    + `Output: ${step.output ?? '(no output)'}\n`
    + (step.error ? `Error: ${step.error}\n` : ''),
  ).join('\n');
  const voiceSystemPrompt = appendSystemPromptAddons(
    compact
      ? `Write the final LS reply for one completed Runtime-validated read-only tool call. Answer exactly what the user asked, in the user's language. Preserve supplied facts, truncation, and uncertainty; invent nothing and omit internal workflow. Return only the concise reply.`
      : `You are the final response assembler. Produce the final user-facing answer from completed task-book step results.
Follow progressive disclosure: lead with the outcome and completion status, then give key results, artifacts, evidence, and the next action only when useful. Keep detail proportional to the user's request; simple tasks should not become reports. Do not dump raw command output or private chain-of-thought. Never hide failed or partial steps, permission denials, risks, uncertainty, external side effects, or decisions required from the user. Do not claim failed steps succeeded.`,
    {
      id: 'profile',
      text: compact ? buildCompactBehaviorProfileAddon(ctx) : ctx.profilePromptAddon,
      placement: 'stable',
    },
    { id: 'reasoning', text: ctx.reasoningPromptAddon, placement: 'stable' },
    {
      id: 'user-facing-voice',
      text: compact ? buildCompactUserFacingVoiceAddon(ctx) : buildUserFacingVoiceAddon(ctx),
    },
  );

  const requestFinalReply = async (
    citationRepair?: { generatedReply: string; reason: string },
  ): Promise<string> => {
    const webContract = ctx.webEvidence ? webCitationRepairContract(ctx.webEvidence) : undefined;
    const rawRequest = {
      model: deps.model,
      messages: [
        {
          // Byte identical for the first answer and for a citation repair: the
          // provider caches the system message ahead of the history, so
          // appending the repair contract here would rebill the transcript.
          role: 'system',
          content: [
            voiceSystemPrompt,
            webContract,
            citationRepair
              ? `The previous draft failed Runtime citation validation: ${citationRepair.reason}`
              : undefined,
          ].filter(Boolean).join('\n\n'),
        },
        {
          role: 'user',
          content: [
            compact
              ? `Request: ${textOf(ctx.inbound)}\n\n`
                + `Verified ${taskBook.steps[0]!.toolProposal!.name} result:\n${stepResults[0]!.output}\n\n`
                + 'Reply only.'
              : `Original request:\n${textOf(ctx.inbound)}\n\n`
                + `Task goal:\n${taskBook.goal}\n\n`
                + `Success criteria:\n${taskBook.successCriteria.map((item) => `- ${item}`).join('\n')}\n\n`
                + `Step results:\n${stepSummary}\n\n`
                + `Write the final reply in the user's language.`,
            ...(citationRepair ? [`Invalid prior draft:\n${citationRepair.generatedReply}`] : []),
            ...(ctx.webEvidence ? [
              `Durable Web evidence projection:\n${JSON.stringify(modelFacingWebEvidence(ctx.webEvidence))}`,
            ] : []),
          ].join('\n\n'),
        },
      ],
      temperature: 0.65,
      max_tokens: compact ? 300 : 900,
      signal: ctx.signal,
    } satisfies import('@littlesheep/llm').ChatRequest;
    const retryOf = citationRepair ? ctx.modelRequests?.at(-1)?.id : undefined;
    const request = prepareModelRequest(
      ctx,
      'execute_final_reply',
      preferDirectModelOutput(ctx, rawRequest, { force: true }),
      buildRunRequestCandidates(ctx, 'execute', rawRequest.messages, {
        history: [],
        primaryUserKind: 'workflow_state',
      }),
      {
        retryOf,
        retryReason: citationRepair ? 'citation' : undefined,
      },
    );
    let streamed = '';
    const stream = ctx.onAssistantDelta !== undefined;
    if (stream && citationRepair) ctx.onAssistantReplace?.('');
    const response = stream
      ? await callModelChatStream(ctx, deps.llm, request, (chunk) => {
          if (chunk.type === 'reset') {
            streamed = '';
            ctx.onAssistantReplace?.('');
          } else if (chunk.type === 'delta' && chunk.delta) {
            streamed += chunk.delta;
            ctx.onAssistantDelta?.(chunk.delta);
          }
        })
      : await callModelChat(ctx, deps.llm, request);
    return response.content || streamed;
  };

  const requestCitationValidReply = async (): Promise<string> => {
    let generated = await requestFinalReply();
    for (let attempt = 0; attempt <= MAX_WEB_CITATION_REPAIRS; attempt += 1) {
      const validation = validateWebCitations(generated, ctx.webEvidence);
      if (validation.ok) return generated;
      if (!ctx.webEvidence || attempt >= MAX_WEB_CITATION_REPAIRS) {
        throw new Error(`web citation validation failed: ${validation.reason}`);
      }
      generated = await requestFinalReply({
        generatedReply: generated,
        reason: validation.reason ?? 'invalid citation',
      });
    }
    return generated;
  };

  const initial = await requestCitationValidReply();
  const published = await publishUserFacingReply(ctx, 'execute_final_reply', initial, replyStage);
  if (!published) {
    throw new Error('the final reply settlement already holds a different published answer');
  }
  return published;
}

/** Keep diagnostic error ids in Runtime/UI only; the model receives user-visible evidence state. */
function modelFacingWebEvidence(evidence: WebEvidenceProjection): Omit<WebEvidenceProjection, 'errorKinds'> {
  const { errorKinds: _errorKinds, ...visible } = evidence;
  return visible;
}
