// Owns the single main-loop execution path; delegates tool loops, failure policy, and reply publication.
import type { SystemPromptBundle } from '@littlesheep/prompt';
import type {
  ClarificationRequest,
  RunContext,
  StageResult,
} from '@littlesheep/types';
import { attachmentContextMessages, conversationHistoryForModel, textOf } from '../_shared.js';
import type { ExecuteSanitizeOptions, ExecuteStageDeps } from './contracts.js';
import { buildBaseMessages } from './guidance.js';
import { runToolLoop } from './tool-loop.js';
import { repairDiscontinuousReply } from '../reply/continuity-repair.js';
import { publishUserFacingReply } from '../../user-facing-reply.js';
import { clearReplyState } from '../../reply-state.js';
import { writeDecisionState } from '../../decision-state.js';
import { recordFailure } from '../../failure-state.js';
import { replaceToolResults } from '../../execution-evidence-state.js';
import { resolveExplicitToolInstructionSet } from '../../explicit-tool-instruction.js';
import { toolsForRetrievalIntent, renderRetrievalIntentContract } from '../../retrieval-intent.js';

export async function executeLegacyLoop(
  deps: ExecuteStageDeps,
  ctx: RunContext,
  systemPrompt: SystemPromptBundle,
  sanitizeOpts: ExecuteSanitizeOptions,
): Promise<StageResult> {
  const attachmentMessages = attachmentContextMessages(ctx.runId, ctx.attachments);
  const explicitTools = resolveExplicitToolInstructionSet(ctx, { allowContinuation: true })
    ?.entries.map((entry) => entry.tool);
  // The model catalog is fixed for the whole session; the Runtime-owned
  // retrieval decision narrows what this turn may *execute*, not what the model
  // may see. Filtering the visible catalog instead changed the tool schemas that
  // sit inside the request prefix, so a local -> web -> local turn sequence
  // invalidated the cached conversation each time the intent changed. The
  // withheld capability is now refused at the execution boundary.
  const admittedTools = explicitTools ?? toolsForRetrievalIntent(ctx);
  const catalogTools = explicitTools ?? ctx.tools;
  // The system message is the above-boundary half of the bundle, exactly like
  // REPLY's. Sections below the boundary (runtime facts, directives, bootstrap,
  // summary, memory index at the tail) travel as their own Context messages, so
  // the session's two paths describe the same layout instead of one sending the
  // whole prompt as the system message and the other only its stable half.
  const baseMessages = buildBaseMessages(
    ctx,
    systemPrompt.stableText ?? systemPrompt.text,
    attachmentMessages,
  );
  const result = await runToolLoop(deps, {
    ctx,
    messages: baseMessages,
    tools: catalogTools,
    admittedTools,
    ...(catalogTools.length === admittedTools.length
      ? {}
      : { withheldToolContract: renderRetrievalIntentContract(ctx) }),
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
    // text. The bounded continuity correction belongs to purely conversational
    // answers: when the loop produced tool evidence, the answer is grounded in
    // that evidence and is published as the Provider wrote it, exactly like the
    // execution paths always did.
    const candidate = result.toolResults.length > 0
      ? result.content
      : await repairDiscontinuousReply(
          deps,
          ctx,
          systemPrompt.text,
          baseMessages,
          conversationHistoryForModel(ctx),
          result.content,
        );
    await publishUserFacingReply(ctx, 'execute_tool_loop', candidate);
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
