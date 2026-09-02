import type { ChatMessage } from '@littlesheep/llm';
import type { SystemPromptBundle } from '@littlesheep/prompt';
import { assembleSystemPromptBundle, resolvePromptConfig } from '@littlesheep/prompt';
import type { AgentTool, LlmCallPurpose, RunContext } from '@littlesheep/types';
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
  renderCompactAutonomousReadDecisionContract,
  renderCompactAutonomousReadWorkspace,
  resolveCompactAutonomousReadDecisionTools,
} from '../../compact-autonomous-read-task.js';
import {
  renderExplicitToolProposalContract,
  resolveExplicitSingleToolInstruction,
  resolveExplicitToolInstructionSet,
  type ExplicitSingleToolInstruction,
} from '../../explicit-tool-instruction.js';
import { renderReplanFeedback } from './replan.js';
import { renderDeferredRuntimeEvents } from './runtime-events.js';
import { renderRetrievalIntentContract, toolsForRetrievalIntent } from '../../retrieval-intent.js';

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
  proposalToolNames?: string[];
  callPurpose: Extract<LlmCallPurpose, 'decide' | 'decide_explicit_tool'>;
  compactExplicitTool?: ExplicitSingleToolInstruction;
  compactAutonomousReadTools?: AgentTool[];
  decisionToolNames: string[];
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
  const compactAutonomousReadTools = compactExplicitTool
    ? undefined
    : resolveCompactAutonomousReadDecisionTools(ctx);
  const compactAutonomousRead = Boolean(compactAutonomousReadTools);
  const compactDecision = Boolean(compactExplicitTool) || compactAutonomousRead;
  const retrievalTools = toolsForRetrievalIntent(ctx);
  const callPurpose = compactExplicitTool ? 'decide_explicit_tool' : 'decide';
  const baseSystemPrompt = compactExplicitTool
    ? await assembleSystemPromptBundle(resolved, { tools: [], bootstrap: {} }, 'none')
    : compactAutonomousReadTools
      ? await assembleSystemPromptBundle(resolved, { tools: [], bootstrap: {} }, 'none')
    : await assembleSystemPromptBundle(resolved, {
        tools: explicitToolInstructions
          ? explicitToolInstructions.entries.map((entry) => entry.tool)
          : retrievalTools,
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
          placement: 'stable',
        },
        { id: 'profile', text: buildCompactBehaviorProfileAddon(ctx), placement: 'stable' },
        { id: 'reasoning', text: ctx.reasoningPromptAddon, placement: 'stable' },
        { id: 'compact-user-facing-voice', text: buildCompactUserFacingVoiceAddon(ctx) },
        {
          id: 'explicit-tool-proposal-contract',
          text: renderCompactExplicitToolProposalContract(compactExplicitTool),
          kind: 'workflow_state',
          source: { kind: 'workflow', id: 'explicit-tool-proposal-contract', runId: ctx.runId },
        },
      ]
    : compactAutonomousReadTools
      ? [
          {
            id: 'compact-read-workspace',
            text: renderCompactAutonomousReadWorkspace(resolved.workspace, compactAutonomousReadTools),
            kind: 'project_knowledge',
            source: { kind: 'configuration', id: 'workspace', path: resolved.workspace },
            scope: 'workspace',
            placement: 'stable',
          },
          { id: 'profile', text: buildCompactBehaviorProfileAddon(ctx), placement: 'stable' },
          { id: 'reasoning', text: ctx.reasoningPromptAddon, placement: 'stable' },
          { id: 'compact-user-facing-voice', text: buildCompactUserFacingVoiceAddon(ctx) },
          {
            id: 'compact-read-only-decision-contract',
            text: renderCompactAutonomousReadDecisionContract(compactAutonomousReadTools),
            kind: 'workflow_state',
            source: { kind: 'workflow', id: 'compact-read-only-decision-contract', runId: ctx.runId },
          },
        ]
    : [
        ...(!explicitToolInstructions ? [{
          id: 'decide-contract',
          text: DECIDE_SYSTEM_PROMPT,
          kind: 'workflow_state' as const,
          source: { kind: 'workflow' as const, id: 'decide-contract', runId: ctx.runId },
          placement: 'stable' as const,
        }] : []),
        ...(!explicitToolInstructions ? [{
          id: 'retrieval-intent-contract',
          text: renderRetrievalIntentContract(ctx),
          kind: 'workflow_state' as const,
          source: { kind: 'workflow' as const, id: 'retrieval-intent-contract', runId: ctx.runId },
        }] : []),
        { id: 'profile', text: ctx.profilePromptAddon, placement: 'stable' },
        { id: 'reasoning', text: ctx.reasoningPromptAddon, placement: 'stable' },
        ...(explicitToolInstructions ? [{
          id: 'explicit-tool-proposal-contract',
          text: renderExplicitToolProposalContract(explicitToolInstructions),
          kind: 'workflow_state' as const,
          source: { kind: 'workflow' as const, id: 'explicit-tool-proposal-contract', runId: ctx.runId },
        }] : []),
      ]);
  const history = compactDecision ? [] : recentHistoryForModel(ctx.history, 8);
  const attachmentMessages = compactDecision
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
    proposalToolNames: explicitToolInstructions?.names
      ?? compactAutonomousReadTools?.map((tool) => tool.name),
    callPurpose,
    compactExplicitTool,
    compactAutonomousReadTools,
    decisionToolNames: explicitToolInstructions?.entries.map((entry) => entry.tool.name)
      ?? compactAutonomousReadTools?.map((tool) => tool.name)
      ?? retrievalTools.map((tool) => tool.name),
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
