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
import { resolveExplicitToolInstructionSet, renderExplicitToolScopeContract } from '../../explicit-tool-instruction.js';
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
  // The model catalog is fixed for the whole session and nothing a turn says may
  // narrow it: the tool schemas sit inside the request prefix, so a catalog that
  // followed the wording invalidated the cached conversation from the change
  // point onward. What the user explicitly names is an execution-scope decision.
  const catalogTools = ctx.tools;
  const scopeTools = toolsForRetrievalIntent(ctx);
  // The Runtime owns the retrieval scope. An explicit instruction may only
  // narrow what this turn may *execute* inside that scope, never widen it:
  // letting it replace the scope admitted a Web tool on a turn whose Runtime
  // contract still said not to plan or request Web tools.
  const admittedTools = explicitTools
    ? scopeTools.filter((tool) => explicitTools.some((named) => named.name === tool.name))
    : scopeTools;
  // The system message is exactly the sections above the cache boundary, and
  // every section below it travels as its own message. Handing the assembler the
  // whole section list instead made it rebuild the system message out of the
  // below-boundary sections too — measured at 4,058 characters instead of the
  // 2,323 the prompt's own layout declares — so the boundary the prompt
  // publishes and the boundary the request respected were not the same one.
  const baseMessages = buildBaseMessages(
    ctx,
    systemPrompt.stableText ?? systemPrompt.text,
    attachmentMessages,
  );
  // system + history + inserted attachments + this turn's user message.
  const historyChatCount = Math.max(0, baseMessages.length - 2 - attachmentMessages.length);
  // The withholding note names its cause: the Runtime retrieval scope when the
  // scope narrowed the turn, the user's own instruction when that narrowed it
  // further. Both travel below the cache boundary with the other tail contracts.
  const withheldToolContract = catalogTools.length === admittedTools.length
    ? undefined
    : explicitTools
      ? renderExplicitToolScopeContract(admittedTools.map((tool) => tool.name))
      : renderRetrievalIntentContract(ctx);
  const result = await runToolLoop(deps, {
    ctx,
    messages: baseMessages,
    tools: catalogTools,
    admittedTools,
    historyChatCount,
    ...(withheldToolContract ? { withheldToolContract } : {}),
    sanitizeOpts,
    systemSegments: systemPrompt.stableSegments ?? systemPrompt.segments,
    // The bundle's below-boundary sections are appended once, in the order the
    // prompt rendered them, by the same ledger that owns the retrieval contract.
    tailSegments: systemPrompt.trailingSegments ?? [],
    insertedBeforePrimary: attachmentMessages.map((item) => item.context),
  });
  replaceToolResults(ctx, 'execute', result.toolResults);
  if (process.env.LS_TAIL_DEBUG) {
    console.log('RUNNER RESULT', JSON.stringify({
      requestMessages: result.requestMessages?.length ?? null,
      first: typeof result.requestMessages?.[0]?.content === 'string'
        ? result.requestMessages[0]!.content.length
        : -1,
      tail: result.requestTailMessages?.size ?? null,
      tools: result.requestTools?.length ?? null,
    }));
  }
  // Asking the user is the model's own decision: the question it raised becomes
  // the turn's clarification and is published as-is. The model already worded it
  // in the tool call it made, so asking it to word the same question again was a
  // second Provider request for text that already existed; the provenance is
  // pinned to the request that actually produced it. The runtime never authors
  // the answer and never decides on its own to wait.
  if (result.userInputRequest) {
    const userInputRequest = result.userInputRequest;
    const clarificationRequest: ClarificationRequest = {
      id: `${ctx.runId}:user-input`,
      kind: 'ambiguous_request',
      sourceStage: 'execute',
      createdAt: new Date().toISOString(),
      originalRequest: textOf(ctx.inbound),
      copySource: 'model',
      // The model authored this wording in the request it used to ask, so the
      // stage that publishes it cites that request and needs no second call.
      ...(result.modelRequestId ? { copyModelRequestId: result.modelRequestId } : {}),
      prompt: userInputRequest.prompt,
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
    //
    // The correction extends the request that produced the draft — same purpose,
    // same messages, same tool catalog — so it keeps the prefix that request
    // already prefilled instead of restating everything in a new shape.
    const candidate = result.toolResults.length > 0
      ? result.content
      : await repairDiscontinuousReply(          deps,
          ctx,
          {
            purpose: 'execute_tool_loop',
            messages: result.requestMessages ?? baseMessages,
            tools: result.requestTools,
            ...(result.requestTailMessages ? { tailMessages: result.requestTailMessages } : {}),
            temperature: 0,
          },
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
