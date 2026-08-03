import type { ChatMessage } from '@littlesheep/llm';
import type { SystemPromptBundle } from '@littlesheep/prompt';
import { assembleSystemPromptBundle, resolvePromptConfig } from '@littlesheep/prompt';
import type { LlmCallPurpose, RunContext } from '@littlesheep/types';
import { buildRunRequestCandidates } from '../../context-candidates.js';
import {
  appendSystemPromptBundleAddons,
  buildCompactBehaviorProfileAddon,
  buildCompactUserFacingVoiceAddon,
} from '../../profile-prompt.js';
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
  canUseCompactExplicitToolDecision,
  renderCompactExplicitToolProposalContract,
} from '../../compact-explicit-tool-decision.js';
import {
  renderExplicitToolProposalContract,
  resolveExplicitSingleToolInstruction,
  resolveExplicitToolInstructionSet,
  type ExplicitSingleToolInstruction,
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
  callPurpose: Extract<LlmCallPurpose, 'decide' | 'decide_explicit_tool'>;
  compactExplicitTool?: ExplicitSingleToolInstruction;
}

export async function buildDecideRequest(
  deps: DecideStageDeps,
  ctx: RunContext,
): Promise<DecideRequest> {
  const resolved = resolvePromptConfig(deps.config, deps.branding);
  const explicitToolInstructions = resolveExplicitToolInstructionSet(ctx);
  const previousTaskBook = ctx.taskBook;
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
  const compactExplicitTool = canUseCompactExplicitToolDecision(ctx)
    ? resolveExplicitSingleToolInstruction(ctx)
    : undefined;
  const callPurpose = compactExplicitTool ? 'decide_explicit_tool' : 'decide';
  const baseSystemPrompt = compactExplicitTool
    ? await assembleSystemPromptBundle(resolved, { tools: [], bootstrap: {} }, 'none')
    : await assembleSystemPromptBundle(resolved, {
        tools: explicitToolInstructions
          ? explicitToolInstructions.entries.map((entry) => entry.tool)
          : ctx.tools,
        bootstrap: ctx.bootstrap ?? {},
        prelude: ctx.prelude,
        sessionSummary: ctx.sessionSummary,
        memoryRootIndex: ctx.memoryRootIndex,
        initialMemoryContext: ctx.initialMemoryContext,
      });
  const systemPrompt = appendSystemPromptBundleAddons(baseSystemPrompt, compactExplicitTool
    ? [
        {
          id: 'explicit-tool-workspace',
          text: 'Use relative tool paths; Runtime resolves them against the active LS workspace.',
          kind: 'project_knowledge',
          source: { kind: 'configuration', id: 'workspace', path: resolved.workspace },
          scope: 'workspace',
        },
        { id: 'profile', text: buildCompactBehaviorProfileAddon(ctx) },
        { id: 'reasoning', text: ctx.reasoningPromptAddon },
        { id: 'compact-user-facing-voice', text: buildCompactUserFacingVoiceAddon(ctx) },
        {
          id: 'explicit-tool-proposal-contract',
          text: renderCompactExplicitToolProposalContract(compactExplicitTool),
          kind: 'workflow_state',
          source: { kind: 'workflow', id: 'explicit-tool-proposal-contract', runId: ctx.runId },
        },
      ]
    : [
        ...(!explicitToolInstructions ? [{
          id: 'decide-contract',
          text: DECIDE_SYSTEM_PROMPT,
          kind: 'workflow_state' as const,
          source: { kind: 'workflow' as const, id: 'decide-contract', runId: ctx.runId },
        }] : []),
        { id: 'profile', text: ctx.profilePromptAddon },
        { id: 'reasoning', text: ctx.reasoningPromptAddon },
        ...(explicitToolInstructions ? [{
          id: 'explicit-tool-proposal-contract',
          text: renderExplicitToolProposalContract(explicitToolInstructions),
          kind: 'workflow_state' as const,
          source: { kind: 'workflow' as const, id: 'explicit-tool-proposal-contract', runId: ctx.runId },
        }] : []),
      ]);
  const history = compactExplicitTool ? [] : recentHistoryForModel(ctx.history, 8);
  const attachmentMessages = compactExplicitTool
    ? []
    : attachmentContextMessages(ctx.runId, ctx.attachments);
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
    callPurpose,
    compactExplicitTool,
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
