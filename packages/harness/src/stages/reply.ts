// @littlesheep/harness — stages/reply.ts
// REPLY: chat-classified messages get a simple LLM reply (no tools).

import type { RunContext, StageResult, UserFacingReplyPurpose } from '@littlesheep/types';
import {
  containsUnquotedDsmlControlMarkup,
  type LlmClient,
  type ChatMessage,
  type ChatRequest,
} from '@littlesheep/llm';
import type { Config } from '@littlesheep/config';
import type { BrandingConfig } from '@littlesheep/branding';
import { assembleSystemPromptBundle, resolvePromptConfig } from '@littlesheep/prompt';
import {
  attachmentContextMessages,
  conversationHistoryForModel,
  toChatMessage,
  textOf,
  userChatMessage,
} from './_shared.js';
import { appendSystemPromptBundleAddons, buildUserFacingVoiceAddon } from '../profile-prompt.js';
import {
  preferDirectModelOutput,
  prepareModelRequest,
  callModelChat,
  callModelChatStream,
  modelRequestIdFor,
} from '../model-observability.js';
import { buildRunRequestCandidates } from '../context-candidates.js';
import {
  acceptUniqueUserFacingReply,
  type ReplyRewriteInput,
} from '../user-facing-reply.js';
import { clearReplyState } from '../reply-state.js';
import { recordFailure } from '../failure-state.js';
import { synthesizeFinalReply } from './execute/final-reply.js';
import { repairDiscontinuousReply } from './reply/continuity-repair.js';

export interface ReplyStageDeps {
  llm: LlmClient;
  model: string;
  config: Config;
  branding: BrandingConfig;
}

const CAPABILITY_REPLY_CONTRACT = [
  'Capability answer contract:',
  '- Answer only from the Runtime Capability Snapshot and Capability Probe facts supplied below.',
  '- Distinguish a registered or permitted capability from an action actually performed.',
  '- Say that a capability probe was observed only when the Runtime facts explicitly say so.',
  '- Do not claim that a Web query occurred unless a corresponding Web tool event is present; a capability probe is not a Web query.',
  '- Do not invent a specific Runtime error, permission change, network state or completion result.',
  '- Return one concise user-facing answer in the user\'s language. Do not expose internal stages or private reasoning.',
].join('\n');

/** Factory: creates a reply stage. */
export function createReplyStage(deps: ReplyStageDeps) {
  return async function replyStage(ctx: RunContext): Promise<StageResult> {
    clearReplyState(ctx, 'reply');
    if (ctx.resumedFromCheckpointId && ctx.taskBook && (ctx.taskExecution?.steps.length ?? 0) > 0) {
      try {
        await synthesizeFinalReply(deps, ctx, ctx.taskBook, ctx.taskExecution!.steps, 'reply');
        return {
          stage: 'reply',
          next: 'verify',
          ok: true,
          meta: { resumedTaskFinalReply: true },
        };
      } catch (err) {
        clearReplyState(ctx, 'reply');
        const message = `resumed task final reply generation failed: ${(err as Error).message}`;
        recordFailure(ctx, 'reply', 'reply', message);
        return {
          stage: 'reply',
          next: 'exit',
          ok: false,
          error: message,
        };
      }
    }
    const resolved = resolvePromptConfig(deps.config, deps.branding);
    const isCapabilityReply = ctx.classification?.retrievalIntent === 'capability_question'
      || ctx.classification?.retrievalIntent === 'capability_probe';
    const replyPurpose: UserFacingReplyPurpose = isCapabilityReply ? 'capability_reply' : 'reply';
    // RESPOND keeps continuity, selected memory, voice and runtime capabilities,
    // but omits execution-only workflow, memory-navigation and tool discipline.
    const baseSystemPrompt = await assembleSystemPromptBundle(resolved, {
      tools: ctx.tools,
      bootstrap: respondBootstrap(ctx.bootstrap),
      sessionSummary: isCapabilityReply ? undefined : ctx.sessionSummary,
      memoryRootIndex: isCapabilityReply ? undefined : ctx.memoryRootIndex,
      initialMemoryContext: isCapabilityReply ? undefined : ctx.initialMemoryContext,
    }, 'respond');
    const systemPrompt = appendSystemPromptBundleAddons(baseSystemPrompt, [
      { id: 'profile', text: ctx.profilePromptAddon, placement: 'stable' },
      { id: 'capability-reply-contract', text: isCapabilityReply ? CAPABILITY_REPLY_CONTRACT : undefined, placement: 'stable' },
      { id: 'user-facing-voice', text: buildUserFacingVoiceAddon(ctx), placement: isCapabilityReply ? 'stable' : undefined },
    ]);

    const attachmentMessages = isCapabilityReply ? [] : attachmentContextMessages(ctx.runId, ctx.attachments);
    const history = isCapabilityReply ? [] : conversationHistoryForModel(ctx);
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: systemPrompt.text,
      },
      ...history.map(toChatMessage),
      ...attachmentMessages.map((item) => item.message),
      userChatMessage(textOf(ctx.inbound), ctx.attachments),
    ];

    let reply: string;
    let streamed = '';
    // Next path only: a direct answer is still a turn the user watches, so
    // its thinking is published as one 思考 row before the answer text.
    const transcriptEnabled = ctx.streamModelTranscript === true && typeof ctx.onToolEvent === 'function';
    const replyPhaseId = `reply:${ctx.runId ?? 'run'}`;
    let replyReasoning = '';
    let replyAttempt = 1;
    let replySequence = 0;
    try {
      const stream = ctx.onAssistantDelta !== undefined;
      const rawRequest = {
        model: deps.model,
        messages,
        temperature: isCapabilityReply ? 0.3 : 0.7,
        max_tokens: isCapabilityReply ? 500 : 1_200,
        signal: ctx.signal,
        stream,
      } satisfies ChatRequest;
      const req = prepareModelRequest(
        ctx,
        replyPurpose,
        preferDirectModelOutput(ctx, rawRequest, { force: true }),
        buildRunRequestCandidates(ctx, 'reply', rawRequest.messages, {
          history,
          systemSegments: systemPrompt.segments,
          insertedBeforePrimary: attachmentMessages.map((item) => item.context),
        }),
      );
      const replyRequestId = modelRequestIdFor(req);
      const res = stream
        ? await callModelChatStream(ctx, deps.llm, req, (chunk) => {
            if (chunk.type === 'reset') {
              replyAttempt = chunk.transportAttempt ?? replyAttempt + 1;
              replySequence = 0;
              streamed = '';
              replyReasoning = '';
              if (transcriptEnabled) {
                emitReplyThinking(ctx, replyPhaseId, '', 'reset', replyRequestId, replyAttempt, ++replySequence);
              }
              ctx.onAssistantReplace?.('');
              return;
            }
            if (chunk.type === 'reasoning_delta' && chunk.delta) {
              if (transcriptEnabled) {
                if (chunk.transportAttempt && chunk.transportAttempt !== replyAttempt) {
                  replyAttempt = chunk.transportAttempt;
                  replySequence = 0;
                }
                replyReasoning = boundedReasoningText(replyReasoning + chunk.delta);
                emitReplyThinking(
                  ctx,
                  replyPhaseId,
                  chunk.delta,
                  'append',
                  replyRequestId,
                  replyAttempt,
                  ++replySequence,
                );
              }
              return;
            }
            if (chunk.type === 'delta' && chunk.delta) {
              streamed += chunk.delta;
              ctx.onAssistantDelta?.(chunk.delta);
            }
          })
        : await callModelChat(ctx, deps.llm, req);
      const rawReply = res.content || streamed;
      // No composing stage may end a turn with empty text. FINALIZE only
      // publishes Provider-traceable text, so a canned string cannot stand in:
      // allow exactly one bounded retry, then fail loudly. Measured before this
      // guard: seven turns in one 8x5 sample ended as HTTP 200 with no reply,
      // which hid the failure instead of surfacing it.
      let visibleReply = rawReply;
      if (!visibleReply.trim()) {
        const retryMessages: ChatMessage[] = [
          ...messages,
          {
            role: 'user',
            content: 'Your previous response contained no visible text. Answer the latest request now in one short message, or ask exactly one question if a missing detail blocks you. Return only the message text.',
          },
        ];
        const retryRequest = prepareModelRequest(
          ctx,
          replyPurpose,
          preferDirectModelOutput(ctx, {
            model: deps.model,
            messages: retryMessages,
            temperature: isCapabilityReply ? 0.3 : 0.7,
            max_tokens: isCapabilityReply ? 500 : 1_200,
            signal: ctx.signal,
            stream: false,
          } satisfies ChatRequest, { force: true }),
          buildRunRequestCandidates(ctx, 'reply', retryMessages, {
            history,
            systemSegments: systemPrompt.segments,
            insertedBeforePrimary: attachmentMessages.map((item) => item.context),
          }),
          { retryOf: replyRequestId, retryReason: 'empty_output' },
        );
        visibleReply = (await callModelChat(ctx, deps.llm, retryRequest)).content;
        if (!visibleReply.trim()) {
          const message = 'reply stage produced no visible text after one bounded retry';
          recordFailure(ctx, 'reply', 'reply', message);
          return {
            stage: 'reply',
            next: 'exit',
            ok: false,
            error: message,
          };
        }
      }
      // A respond request deliberately has no tool authority. Provider-emitted
      // control syntax is a protocol failure, not permission to upgrade this
      // run into an executing route.
      if (containsUnquotedDsmlControlMarkup(visibleReply)) {
        ctx.onAssistantReplace?.('');
        const message = 'respond provider returned tool control markup without tool authority';
        recordFailure(ctx, 'reply', 'reply', message);
        return {
          stage: 'reply',
          next: 'exit',
          ok: false,
          error: message,
          meta: { protocolError: 'tool_control_markup_without_authority' },
        };
      }
      if (transcriptEnabled && replyReasoning.trim()) {
        emitReplyThinking(
          ctx,
          replyPhaseId,
          replyReasoning,
          'replace',
          replyRequestId,
          replyAttempt,
          ++replySequence,
        );
      }
      const apiGeneratedReply = isCapabilityReply
        ? visibleReply
        : await repairDiscontinuousReply(
            deps,
            ctx,
            systemPrompt.text,
            messages,
            history,
            visibleReply,
          );
      reply = await acceptUniqueUserFacingReply(
        ctx,
        replyPurpose,
        apiGeneratedReply,
        (input) => rewriteReply(deps, ctx, systemPrompt.text, messages, input, replyPurpose),
      );
      // Streamed text is provisional. Replace it only after the complete
      // model reply passes the durable duplicate gate.
      if (reply !== streamed.trim()) ctx.onAssistantReplace?.(reply);
    } catch (err) {
      if (streamed) ctx.onAssistantReplace?.('');
      const message = `user-facing reply generation failed: ${(err as Error).message}`;
      recordFailure(ctx, 'reply', 'reply', message);
      return {
        stage: 'reply',
        next: 'exit',
        ok: false,
        error: message,
      };
    }

    return {
      stage: 'reply',
      next: 'finalize',
      ok: true,
    };
  };
}

async function rewriteReply(
  deps: ReplyStageDeps,
  ctx: RunContext,
  systemPrompt: string,
  originalMessages: ChatMessage[],
  input: ReplyRewriteInput,
  purpose: Extract<UserFacingReplyPurpose, 'reply' | 'capability_reply'> = 'reply',
): Promise<string> {
  const isCapabilityReply = purpose === 'capability_reply';
  const rawRequest = {
    model: deps.model,
    messages: [
      {
        role: 'system' as const,
        content: `${systemPrompt}\n\nRegeneration contract:\n- The prior API-generated response exactly repeats a previously published LS reply.\n- Generate the answer again with a genuinely different opening and sentence structure.\n- Preserve the original answer, scope, uncertainty and user language.\n- Do not mention this regeneration request or the comparison.\n- Return only the new user-facing reply.`,
      },
      ...originalMessages.slice(1),
      {
        role: 'user' as const,
        content: [
          `Prior API-generated response:\n${input.generatedReply}`,
          `Recent replies to avoid repeating exactly:\n${input.avoidReplies.map((reply, index) => `${index + 1}. ${reply}`).join('\n')}`,
        ].join('\n\n'),
      },
    ],
    temperature: isCapabilityReply ? 0.45 : 0.75,
    max_tokens: isCapabilityReply ? 500 : 1_200,
    signal: ctx.signal,
    stream: false,
  } satisfies ChatRequest;
  const request = prepareModelRequest(
    ctx,
    purpose,
    preferDirectModelOutput(ctx, rawRequest, { force: true }),
    buildRunRequestCandidates(ctx, 'reply', rawRequest.messages, {
      history: isCapabilityReply ? [] : conversationHistoryForModel(ctx),
      primaryUserKind: 'user_input',
    }),
    { retryOf: ctx.modelRequests?.at(-1)?.id, retryReason: 'duplicate' },
  );
  const response = await callModelChat(ctx, deps.llm, request);
  return response.content;
}

function respondBootstrap(bootstrap: RunContext['bootstrap']): Record<string, string> {
  const user = bootstrap?.['USER.md']?.trim();
  return user ? { 'USER.md': user } : {};
}

/** Bounded thinking text for one reply-stage row. */
const MAX_REPLY_REASONING_TEXT = 4_000;

function boundedReasoningText(value: string): string {
  return value.length > MAX_REPLY_REASONING_TEXT ? value.slice(-MAX_REPLY_REASONING_TEXT) : value;
}

function emitReplyThinking(
  ctx: RunContext,
  phaseId: string,
  text: string,
  operation: 'append' | 'replace' | 'reset',
  requestId: string | undefined,
  transportAttempt: number,
  sequence: number,
): void {
  try {
    ctx.onToolEvent?.({
      type: 'model_reasoning',
      visibility: 'progress',
      stage: 'reply',
      phaseId,
      reasoningStatus: operation === 'replace' ? 'done' : 'running',
      summary: text,
      ...(requestId ? { streamRef: {
        version: 1,
        runId: ctx.runId,
        requestId,
        transportAttempt,
        sequence,
        operation,
      } } : {}),
    });
  } catch {
    // Thinking delivery is cosmetic; never fail the answer because of it.
  }
}
