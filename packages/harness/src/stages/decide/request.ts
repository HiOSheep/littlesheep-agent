import type { ChatMessage } from '@littlesheep/llm';
import type { SystemPromptBundle } from '@littlesheep/prompt';
import { assembleSystemPromptBundle, resolvePromptConfig } from '@littlesheep/prompt';
import type { RunContext } from '@littlesheep/types';
import { buildRunRequestCandidates } from '../../context-candidates.js';
import { appendSystemPromptBundleAddons } from '../../profile-prompt.js';
import {
  attachmentContextMessages,
  textOf,
  toChatMessage,
  userChatMessage,
  recentHistoryForModel,
  type AttachmentContextMessage,
} from '../_shared.js';
import {
  DECIDE_SYSTEM_PROMPT,
  type DecideStageDeps,
} from './contracts.js';
import {
  renderExplicitToolProposalContract,
  resolveExplicitToolInstructionSet,
} from '../../explicit-tool-instruction.js';
import { renderReplanFeedback } from './replan.js';
import { renderDeferredRuntimeEvents } from './runtime-events.js';

export interface DecideRequest {
  systemPrompt: SystemPromptBundle;
  messages: ChatMessage[];
  inboundText: string;
  attachmentMessages: AttachmentContextMessage[];
  previousTaskBook: RunContext['taskBook'];
  partialReplan: RunContext['partialReplanRequest'];
  deferredRuntimeEvents: NonNullable<RunContext['deferredRuntimeEvents']>;
  history: RunContext['history'];
  replanRequested: boolean;
  explicitToolNames?: string[];
}

export async function buildDecideRequest(
  deps: DecideStageDeps,
  ctx: RunContext,
): Promise<DecideRequest> {
  const resolved = resolvePromptConfig(deps.config, deps.branding);
  const explicitToolInstructions = resolveExplicitToolInstructionSet(ctx);
  const baseSystemPrompt = await assembleSystemPromptBundle(resolved, {
    tools: explicitToolInstructions
      ? explicitToolInstructions.entries.map((entry) => entry.tool)
      : ctx.tools,
    bootstrap: ctx.bootstrap ?? {},
    prelude: ctx.prelude,
    sessionSummary: ctx.sessionSummary,
    memoryRootIndex: ctx.memoryRootIndex,
    initialMemoryContext: ctx.initialMemoryContext,
  });
  const systemPrompt = appendSystemPromptBundleAddons(baseSystemPrompt, [
    ...(!explicitToolInstructions ? [{
      id: 'decide-contract',
      text: DECIDE_SYSTEM_PROMPT,
      kind: 'workflow_state' as const,
      source: { kind: 'workflow' as const, id: 'decide-contract', runId: ctx.runId },
    }] : []),
    { id: 'profile', text: ctx.profilePromptAddon },
    { id: 'reasoning', text: ctx.reasoningPromptAddon },
    // Keep the request-specific output constraint last so generic profile or
    // reasoning guidance cannot dilute the exact proposal shape.
    ...(explicitToolInstructions ? [{
      id: 'explicit-tool-proposal-contract',
      text: renderExplicitToolProposalContract(explicitToolInstructions),
      kind: 'workflow_state' as const,
      source: { kind: 'workflow' as const, id: 'explicit-tool-proposal-contract', runId: ctx.runId },
    }] : []),
  ]);

  const previousTaskBook = ctx.taskBook;
  const history = recentHistoryForModel(ctx.history, 8);
  const partialReplan = ctx.partialReplanRequest;
  const deferredRuntimeEvents = ctx.deferredRuntimeEvents ?? [];
  const replanRequested = Boolean(
    previousTaskBook
    && (partialReplan || ctx.verifyFeedback || deferredRuntimeEvents.length > 0),
  );
  const verifyFeedback = partialReplan && previousTaskBook
    ? renderReplanFeedback(ctx, partialReplan)
    : ctx.verifyFeedback
      ? `\n\n---\nPrevious plan did not achieve the goal. Verify feedback:\n${ctx.verifyFeedback}\nPlease produce a REVISED assessment and taskBook that addresses this feedback.`
      : '';
  const inboundText = textOf(ctx.inbound) || '(empty message)';
  const attachmentMessages = attachmentContextMessages(ctx.runId, ctx.attachments);
  const runtimeEventContext = renderDeferredRuntimeEvents(deferredRuntimeEvents);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt.text },
    ...history.map(toChatMessage),
    ...attachmentMessages.map((item) => item.message),
    userChatMessage(`${inboundText}${verifyFeedback}${runtimeEventContext}`, ctx.attachments),
  ];

  return {
    systemPrompt,
    messages,
    inboundText,
    attachmentMessages,
    previousTaskBook,
    partialReplan,
    deferredRuntimeEvents,
    history,
    replanRequested,
    explicitToolNames: explicitToolInstructions?.names,
  };
}

export function buildDecideRequestCandidates(
  ctx: RunContext,
  request: DecideRequest,
  messages: ChatMessage[],
) {
  return buildRunRequestCandidates(ctx, 'decide', messages, {
    systemSegments: request.systemPrompt.segments,
    history: request.history,
    insertedBeforePrimary: request.attachmentMessages.map((item) => item.context),
  });
}
