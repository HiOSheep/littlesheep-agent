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
import { publishUserFacingReply } from '../user-facing-reply.js';
import { clearReplyState } from '../reply-state.js';
import { recordFailure } from '../failure-state.js';
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
    // The resumed-TaskBook branch is gone with the step executor: a plan restored
    // from a checkpoint is read-only history, so this stage answers the current
    // request (or the capability question) like any other turn.
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
    // One session transcript for every purpose, including capability replies.
    const history = conversationHistoryForModel(ctx);
    const messages: ChatMessage[] = [
      {
        role: 'system',
        // The system message is exactly the above-boundary half of the bundle;
        // the below-boundary sections travel as their own Context messages.
        content: systemPrompt.stableText ?? systemPrompt.text,
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
          trailingSegments: systemPrompt.trailingSegments,
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
            {
              // Same purpose and same messages as the reply request: the
              // correction extends that request instead of restating it in a
              // different shape.
              purpose: replyPurpose,
              messages: req.messages,
              tools: req.tools,
              temperature: req.temperature,
              maxTokens: req.max_tokens,
            },
            history,
            visibleReply,
          );
      reply = await publishUserFacingReply(ctx, replyPurpose, apiGeneratedReply) ?? '';
      // Rule 11.3: the stage must never finish with an accepted-but-empty reply.
      // Without this guard a turn could end `ok: true` while publishing nothing,
      // which is exactly the silent HTTP 200 with an empty reply that the sample
      // showed. Fail loudly instead.
      if (!reply.trim()) {
        const message = 'reply stage accepted no visible text';
        recordFailure(ctx, 'reply', 'reply', message);
        return {
          stage: 'reply',
          next: 'exit',
          ok: false,
          error: message,
        };
      }
      // Streamed text is provisional. Replace it with the text that was
      // actually reserved under this run's settlement identity.
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
