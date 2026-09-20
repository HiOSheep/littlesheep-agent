// Owns legacy and TaskBook execution orchestration; delegates tool loops, failure policy, and final reply synthesis.
import type { SystemPromptBundle } from '@littlesheep/prompt';
import type {
  ClarificationRequest,
  RunContext,
  StageResult,
} from '@littlesheep/types';
import { attachmentContextMessages, textOf } from '../_shared.js';
import type { ExecuteSanitizeOptions, ExecuteStageDeps } from './contracts.js';
import { buildBaseMessages } from './guidance.js';
import { runToolLoop } from './tool-loop.js';
import { publishUserFacingReply } from '../../user-facing-reply.js';
import { clearReplyState } from '../../reply-state.js';
import { writeDecisionState } from '../../decision-state.js';
import { recordFailure } from '../../failure-state.js';
import { replaceToolResults } from '../../execution-evidence-state.js';
import { resolveExplicitToolInstructionSet } from '../../explicit-tool-instruction.js';
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
  if (!result.ok) {
    const message = result.error ?? 'execute failed';
    recordFailure(ctx, 'execute', 'execute', message);
    return { stage: 'execute', next: 'recover', ok: false, error: message };
  }
  try {
    // The tool loop already validated any Web citation before returning this
    // text, so the reply is published exactly as the Provider produced it.
    await publishUserFacingReply(ctx, 'execute_tool_loop', result.content);
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
