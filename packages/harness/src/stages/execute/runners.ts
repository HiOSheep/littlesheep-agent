// Owns legacy and TaskBook execution orchestration; delegates tool loops, failure policy, and final reply synthesis.
import type { SystemPromptBundle } from '@littlesheep/prompt';
import { appendSystemPromptBundleAddons, buildUserFacingVoiceAddon } from '../../profile-prompt.js';
import type {
  ClarificationRequest,
  RunContext,
  StageResult,
} from '@littlesheep/types';
import { attachmentContextMessages, conversationHistoryForModel, textOf } from '../_shared.js';
import type { ExecuteSanitizeOptions, ExecuteStageDeps } from './contracts.js';
import { buildBaseMessages } from './guidance.js';
import { runToolLoop } from './tool-loop.js';
import { acceptUniqueUserFacingReply, type ReplyRewriteInput } from '../../user-facing-reply.js';
import { buildRunRequestCandidates } from '../../context-candidates.js';
import { prepareModelRequest, callModelChat, modelRequestIdFor } from '../../model-observability.js';
import { clearReplyState } from '../../reply-state.js';
import { writeDecisionState } from '../../decision-state.js';
import { recordFailure } from '../../failure-state.js';
import { replaceToolResults } from '../../execution-evidence-state.js';
import { writeReplanState } from '../../replan-state.js';
import { buildWorkPolicyUpgradeRequest } from '../../work-policy-upgrade.js';
import { resolveExplicitToolInstructionSet } from '../../explicit-tool-instruction.js';
import {
  validateWebCitations,
  webCitationRepairContract,
  MAX_WEB_CITATION_REPAIRS,
} from '../../web-citation-validation.js';
export { executeTaskBook } from './task-book-runner.js';

export async function executeLegacyLoop(
  deps: ExecuteStageDeps,
  ctx: RunContext,
  systemPrompt: SystemPromptBundle,
  sanitizeOpts: ExecuteSanitizeOptions,
): Promise<StageResult> {
  const attachmentMessages = attachmentContextMessages(ctx.runId, ctx.attachments);
  const explicitTools = resolveExplicitToolInstructionSet(ctx, { allowContinuation: true })
    ?.entries.map((entry) => entry.tool);
  const result = await runToolLoop(deps, {
    ctx,
    messages: buildBaseMessages(ctx, systemPrompt.text, attachmentMessages),
    tools: explicitTools ?? ctx.tools,
    sanitizeOpts,
    systemSegments: systemPrompt.segments,
    insertedBeforePrimary: attachmentMessages.map((item) => item.context),
  });
  replaceToolResults(ctx, 'execute', result.toolResults);
  // Asking the user is the model's own decision: the question it raised becomes
  // the turn's clarification, ASK_USER composes provider-traceable wording for
  // it, and the runtime records the single waiting fact. The runtime never
  // authors the answer and never decides on its own to wait.
  if (result.userInputRequest) {
    const userInputRequest = result.userInputRequest;
    const clarificationRequest: ClarificationRequest = {
      id: `${ctx.runId}:user-input`,
      kind: 'ambiguous_request',
      sourceStage: 'execute',
      createdAt: new Date().toISOString(),
      originalRequest: textOf(ctx.inbound),
      copySource: 'model',
      blockingReason: userInputRequest.prompt,
      questions: [{
        id: 'question-1',
        field: userInputRequest.field,
        prompt: userInputRequest.prompt,
        required: userInputRequest.required,
        ...(userInputRequest.options ? { options: userInputRequest.options } : {}),
      }],
    };
    writeDecisionState(ctx, 'execute', { clarificationRequest });
    clearReplyState(ctx, 'execute');
    return {
      stage: 'execute',
      next: 'ask_user',
      ok: true,
      meta: {
        userInputRequested: true,
        userInputField: userInputRequest.field,
        iterations: result.iterations,
        toolCalls: result.toolResults.length,
      },
    };
  }
  if (result.workPolicyUpgradeProposal) {
    try {
      const upgrade = buildWorkPolicyUpgradeRequest(ctx, result.workPolicyUpgradeProposal, result.toolResults);
      writeReplanState(ctx, 'execute', { workPolicyUpgradeRequest: upgrade });
      await ctx.persistRuntimeCheckpoint?.(`work policy upgrade ${upgrade.id}`);
      clearReplyState(ctx, 'execute');
      return {
        stage: 'execute',
        next: 'decide',
        ok: true,
        meta: {
          workPolicyUpgradeRequestId: upgrade.id,
          workPolicyUpgradeReasonCode: upgrade.reasonCode,
          iterations: result.iterations,
          toolCalls: result.toolResults.length,
        },
      };
    } catch (error) {
      clearReplyState(ctx, 'execute');
      const message = `TaskBook promotion failed: ${(error as Error).message}`;
      recordFailure(ctx, 'execute', 'execute', message);
      return { stage: 'execute', next: 'recover', ok: false, error: message };
    }
  }
  if (!result.ok) {
    const message = result.error ?? 'execute failed';
    recordFailure(ctx, 'execute', 'execute', message);
    return { stage: 'execute', next: 'recover', ok: false, error: message };
  }
  try {
    await acceptUniqueUserFacingReply(
      ctx,
      'execute_tool_loop',
      result.content,
      (input) => rewriteLegacyExecutionReply(deps, ctx, systemPrompt, input),
    );
  } catch (error) {
    clearReplyState(ctx, 'execute');
    const message = `user-facing execution reply generation failed: ${(error as Error).message}`;
    recordFailure(ctx, 'execute', 'execute', message);
    return { stage: 'execute', next: 'recover', ok: false, error: message };
  }
  return {
    stage: 'execute',
    next: 'verify',
    ok: true,
    meta: { iterations: result.iterations, toolCalls: result.toolResults.length },
  };
}

async function rewriteLegacyExecutionReply(
  deps: ExecuteStageDeps,
  ctx: RunContext,
  systemPrompt: SystemPromptBundle,
  input: ReplyRewriteInput,
): Promise<string> {
  const rewrittenSystem = appendSystemPromptBundleAddons(systemPrompt, [{
    id: 'user-facing-rewrite',
    text: `${buildUserFacingVoiceAddon(ctx)}\n\nThe prior API-generated response exactly repeats a previously published LS reply. Generate the answer again with a genuinely different opening and sentence structure. Preserve runtime facts, execution status, evidence and uncertainty. Do not mention the regeneration. Return only the user-facing reply.`,
  }]);
  const attachments = attachmentContextMessages(ctx.runId, ctx.attachments);
  const rawRequest = {
    model: deps.model,
    messages: [
      ...buildBaseMessages(ctx, rewrittenSystem.text, attachments),
      {
        role: 'user' as const,
        content: `Prior API-generated response:\n${input.generatedReply}\n\nRecent replies to avoid repeating exactly:\n${input.avoidReplies.map((reply, index) => `${index + 1}. ${reply}`).join('\n')}`,
      },
    ],
    temperature: 0.75,
    max_tokens: 4_096,
    signal: ctx.signal,
  } satisfies import('@littlesheep/llm').ChatRequest;
  const request = prepareModelRequest(
    ctx,
    'execute_tool_loop',
    rawRequest,
    buildRunRequestCandidates(ctx, 'execute', rawRequest.messages, {
      history: conversationHistoryForModel(ctx),
      systemSegments: rewrittenSystem.segments,
      insertedBeforePrimary: attachments.map((item) => item.context),
    }),
    { retryOf: ctx.modelRequests?.at(-1)?.id, retryReason: 'duplicate' },
  );
  let currentRequest = request;
  let previousRequestId = modelRequestIdFor(request);
  for (let attempt = 0; attempt <= MAX_WEB_CITATION_REPAIRS; attempt += 1) {
    const response = await callModelChat(ctx, deps.llm, currentRequest);
    const validation = validateWebCitations(response.content, ctx.webEvidence);
    if (validation.ok || !ctx.webEvidence) return response.content;
    if (attempt >= MAX_WEB_CITATION_REPAIRS) {
      throw new Error(`rewritten reply failed Web citation validation: ${validation.reason}`);
    }
    const repairRequest = {
      ...rawRequest,
      messages: [
        ...rawRequest.messages,
        { role: 'assistant' as const, content: response.content },
        {
          role: 'user' as const,
          content: `${webCitationRepairContract(ctx.webEvidence)}\n\nValidation failure: ${validation.reason}`,
        },
      ],
    } satisfies import('@littlesheep/llm').ChatRequest;
    currentRequest = prepareModelRequest(
      ctx,
      'execute_tool_loop',
      repairRequest,
      buildRunRequestCandidates(ctx, 'execute', repairRequest.messages, {
        history: conversationHistoryForModel(ctx),
        systemSegments: rewrittenSystem.segments,
        insertedBeforePrimary: attachments.map((item) => item.context),
      }),
      { retryOf: previousRequestId, retryReason: 'citation' },
    );
    previousRequestId = modelRequestIdFor(currentRequest);
  }
  throw new Error('rewritten reply citation validation exhausted');
}
