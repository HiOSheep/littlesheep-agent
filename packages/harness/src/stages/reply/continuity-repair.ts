// One bounded Provider correction for a reply that contradicts visible continuity evidence.

import type { RunContext } from '@littlesheep/types';
import type { ChatMessage, ChatRequest, LlmClient } from '@littlesheep/llm';
import { buildRunRequestCandidates } from '../../context-candidates.js';
import {
  preferDirectModelOutput,
  prepareModelRequest,
  callModelChat,
} from '../../model-observability.js';
import { assessResponseMemoryContinuity } from '../../response-continuity.js';
import { UserFacingReplyError } from '../../user-facing-reply.js';

interface ContinuityRepairDeps {
  llm: LlmClient;
  model: string;
}

export async function repairDiscontinuousReply(
  deps: ContinuityRepairDeps,
  ctx: RunContext,
  systemPrompt: string,
  originalMessages: ChatMessage[],
  visibleHistory: RunContext['history'],
  candidate: string,
): Promise<string> {
  if (assess(ctx, visibleHistory, candidate) !== 'discontinuous') return candidate;

  // Tool traffic is not a continuity input: the assessment reads the run's tool
  // results directly, and the REPLY contract forbids `tool_result` context, so a
  // correction raised from inside the main loop must not carry it.
  const continuityMessages = originalMessages
    .slice(1)
    .filter((message) => message.role !== 'tool' && (message.tool_calls?.length ?? 0) === 0);

  const rawRequest = {
    model: deps.model,
    messages: [
      {
        role: 'system' as const,
        content: `${systemPrompt}\n\nContinuity correction contract:\n- The previous API-generated draft omitted or contradicted values the user explicitly requested from the visible conversation history.\n- Answer the current request again from that history and preserve requested labels and exact recorded values.\n- Do not invent unavailable facts, mention this correction, or expose private reasoning.\n- Return only the corrected user-facing reply.`,
      },
      ...continuityMessages,
      { role: 'assistant' as const, content: candidate },
      {
        role: 'user' as const,
        content: 'Correct the draft using the visible prior conversation and the current request.',
      },
    ],
    temperature: 0.2,
    max_tokens: 1_200,
    signal: ctx.signal,
    stream: false,
  } satisfies ChatRequest;
  const request = prepareModelRequest(
    ctx,
    'reply',
    preferDirectModelOutput(ctx, rawRequest, { force: true }),
    buildRunRequestCandidates(ctx, 'reply', rawRequest.messages, {
      history: visibleHistory,
      primaryUserKind: 'user_input',
    }),
    { retryOf: ctx.modelRequests?.at(-1)?.id, retryReason: 'continuity' },
  );
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
