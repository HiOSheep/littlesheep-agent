// One bounded Provider correction for a reply that contradicts visible continuity evidence.
//
// The correction is a *prefix-extension* of the request that produced the draft,
// not a differently shaped request of its own. Three things made it different
// before, and each cost the Provider's cached prefix:
//
//   - it appended a "Continuity correction contract" to the system prompt, so the
//     first message differed and nothing after it could match;
//   - it dropped the tool catalog (it ran under the REPLY contract, which allows
//     no tools), so the request had no tools at all;
//   - it rebuilt the message array without the main loop's runtime tail, so the
//     tail's position moved.
//
// Measured on a conversational turn: the correction shared 4,165 of the main
// request's 5,402 characters and advertised zero tools. The correction still
// has to happen — a reply that contradicts what the user just said is wrong —
// but it can happen as bounded appended feedback inside the original request
// shape.

import type { RunContext, UserFacingReplyPurpose } from '@littlesheep/types';
import type { ChatMessage, ChatRequest, LlmClient } from '@littlesheep/llm';
import { buildRunRequestCandidates } from '../../context-candidates.js';
import {
  preferDirectModelOutput,
  prepareModelRequest,
  callModelChat,
} from '../../model-observability.js';
import { assessResponseMemoryContinuity } from '../../response-continuity.js';
import { UserFacingReplyError } from '../../user-facing-reply.js';

export interface ContinuityRepairDeps {
  llm: LlmClient;
  model: string;
}

export interface ContinuityRepairRequestShape {
  /**
   * The purpose the draft was generated under. Reusing it keeps the correction
   * inside the same call contract instead of inventing a second request shape.
   */
  purpose: UserFacingReplyPurpose;
  /** The exact messages the Provider received when it wrote the draft. */
  messages: ChatMessage[];
  /**
   * The subset of `messages` the caller's append-only tail owns. Describing them
   * again while rebuilding the request would move them, so they are identified
   * here instead.
   */
  tailMessages?: ReadonlySet<ChatMessage>;
  tools?: ChatRequest['tools'];
  temperature?: number;
  maxTokens?: number;
}

/** The appended correction, kept as feedback rather than as a rewritten prompt. */
const CONTINUITY_CORRECTION = [
  'Runtime control: the draft above omitted or contradicted values the user explicitly requested from the visible conversation history.',
  'Answer the current request again from that history and preserve the requested labels and exact recorded values.',
  'Do not call a tool; do not invent unavailable facts, mention this correction, or expose private reasoning.',
  'Return only the corrected user-facing reply.',
].join('\n');

export async function repairDiscontinuousReply(
  deps: ContinuityRepairDeps,
  ctx: RunContext,
  shape: ContinuityRepairRequestShape,
  visibleHistory: RunContext['history'],
  candidate: string,
): Promise<string> {
  if (assess(ctx, visibleHistory, candidate) !== 'discontinuous') return candidate;

  const messages: ChatMessage[] = [
    ...shape.messages,
    { role: 'assistant', content: candidate },
    { role: 'user', content: CONTINUITY_CORRECTION },
  ];
  const rawRequest = {
    model: deps.model,
    messages,
    tools: shape.tools,
    // The correction is text-only: the tool list stays so the prefix does, and
    // `none` forbids the call just as effectively.
    tool_choice: shape.tools && shape.tools.length > 0 ? 'none' : undefined,
    temperature: shape.temperature ?? 0.2,
    ...(shape.maxTokens === undefined ? {} : { max_tokens: shape.maxTokens }),
    signal: ctx.signal,
    stream: false,
  } satisfies ChatRequest;
  const request = prepareModelRequest(
    ctx,
    shape.purpose,
    preferDirectModelOutput(ctx, rawRequest, { force: true }),
    buildRunRequestCandidates(ctx, 'reply', rawRequest.messages, {
      history: visibleHistory,
      primaryUserKind: 'user_input',
      // The correction is the request's user turn now, not the original one.
      primaryUserIndex: shape.messages.length + 1,
      // The messages being extended already carry the runtime tail exactly where
      // the request being corrected put it; describing them here a second time
      // would move the tail to a new position and break the prefix.
      ...(shape.tailMessages ? { tailMessages: shape.tailMessages } : {}),
    }),
    {
      retryOf: ctx.modelRequests?.at(-1)?.id,
      retryReason: 'continuity',
      // The tail is already in `shape.messages`.
      skipRuntimeTail: true,
    },
  );
  if (process.env.LS_TAIL_DEBUG) {
    console.log('REPAIR SHAPE', JSON.stringify({
      shapeMessages: shape.messages.length,
      tail: shape.tailMessages?.size ?? 0,
      firstShape: typeof shape.messages[0]?.content === 'string' ? shape.messages[0]!.content.length : -1,
      firstOut: typeof request.messages[0]?.content === 'string' ? request.messages[0]!.content.length : -1,
      out: request.messages.length,
    }));
  }
  const response = await callModelChat(ctx, deps.llm, request);

  const repaired = response.content.trim();
  if (assess(ctx, visibleHistory, repaired) === 'discontinuous') {
    throw new UserFacingReplyError(
      'continuity_repair_failed',
      'The model still omitted or contradicted explicit continuity evidence after one correction request.',
    );
  }
  return repaired;
}

function assess(
  ctx: RunContext,
  visibleHistory: RunContext['history'],
  reply: string,
) {
  return assessResponseMemoryContinuity({
    reply,
    inbound: ctx.inbound,
    history: visibleHistory,
    initialMemoryContext: ctx.initialMemoryContext,
    sessionSummary: ctx.sessionSummary,
    memoryKnownState: ctx.memoryKnownState,
    memoryContextWorkingSet: ctx.memoryContextWorkingSet,
    taskBook: ctx.taskBook,
    toolResults: ctx.toolResults,
  }).status;
}
