// Owns the conservative fast path for one self-contained built-in read tool.
// It never grants execution authority; Runtime expands and revalidates the proposal.

import { composeMemoryTaskQuery } from '@littlesheep/memory-tree';
import type { RunContext } from '@littlesheep/types';
import { isExplicitContinuationRequest } from './continuation-intent.js';
import {
  resolveExplicitSingleToolInstruction,
  type ExplicitSingleToolInstruction,
} from './explicit-tool-instruction.js';
import type { DecodedPlan } from './stages/decide/contracts.js';

const COMPACT_EXPLICIT_READ_TOOLS = new Set(['glob', 'grep', 'read']);
const COMPACT_EXPLICIT_TOOL_SOURCE = 'builtin';
const CONTEXT_DEPENDENT_RESOURCE_PATTERNS: readonly RegExp[] = [
  /(?:刚才|之前|前面|上面|上述|下述|先前|原来(?:的)?|同一个|提到(?:的)?|说(?:过)?的).{0,16}(?:文件|文件夹|目录|路径|项目|工作区|位置|内容|结果|条目|范围)/u,
  /(?:这|那|该)(?:个|些)?(?:文件|文件夹|目录|路径|项目|工作区|位置|内容|结果|条目|范围)/u,
  /\b(?:previous|earlier|above|aforementioned|same|original)\s+(?:file|folder|directory|path|project|workspace|location|content|result|entry|scope)\b/iu,
  /\b(?:this|that|these|those)\s+(?:file|folder|directory|path|project|workspace|location|content|result|entry|scope)\b/iu,
];

export interface CompactExplicitToolDecision {
  userNeed?: string;
  goal?: string;
  successCriterion?: string;
  title?: string;
  description?: string;
  expectedOutput?: string;
  toolProposal?: { name?: unknown; input?: unknown };
  clarification?: { blockingReason?: string; question?: string };
}

/** Admit only a self-contained request whose compact Context cannot hide a dependency. */
export function canUseCompactExplicitToolDecision(
  ctx: Pick<
    RunContext,
    | 'classification'
    | 'inbound'
    | 'tools'
    | 'toolSources'
    | 'attachments'
    | 'taskBook'
    | 'partialReplanRequest'
    | 'verifyFeedback'
    | 'deferredRuntimeEvents'
    | 'clarificationResponse'
    | 'initialMemoryContext'
    | 'memoryKnownState'
    | 'memoryContextWorkingSet'
    | 'resumedFromCheckpointId'
  >,
): boolean {
  const instruction = resolveExplicitSingleToolInstruction(ctx);
  if (!instruction || !COMPACT_EXPLICIT_READ_TOOLS.has(instruction.tool.name)) return false;
  if (ctx.toolSources?.[instruction.tool.name] !== COMPACT_EXPLICIT_TOOL_SOURCE) return false;
  if ((ctx.attachments?.length ?? 0) > 0
    || ctx.taskBook
    || ctx.partialReplanRequest
    || ctx.verifyFeedback
    || (ctx.deferredRuntimeEvents?.length ?? 0) > 0
    || ctx.clarificationResponse
    || ctx.initialMemoryContext?.trim()
    || (ctx.memoryKnownState?.references.length ?? 0) > 0
    || (ctx.memoryContextWorkingSet?.activeAtomIds.length ?? 0) > 0
    || ctx.resumedFromCheckpointId) {
    return false;
  }
  const inboundText = ctx.inbound.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  if (!inboundText.trim() || isExplicitContinuationRequest(inboundText)) return false;
  return composeMemoryTaskQuery(inboundText).referenceKind === 'none'
    && !CONTEXT_DEPENDENT_RESOURCE_PATTERNS.some((pattern) => pattern.test(inboundText));
}

export function renderCompactExplicitToolProposalContract(
  instruction: ExplicitSingleToolInstruction,
): string {
  return `# Explicit Tool Decision

The user explicitly requested exactly one call to the registered tool \`${instruction.tool.name}\`.
Infer the smallest sufficient call from the current user message only. Return one raw JSON object and no markdown:
{
  "userNeed": "precise need in the user's language",
  "goal": "concrete goal in the user's language",
  "successCriterion": "one observable completion condition",
  "title": "short user-language label",
  "description": "one concise step",
  "expectedOutput": "what the user asked to receive",
  "toolProposal": {"name":"${instruction.tool.name}","input":{}}
}

Replace the empty input with concrete arguments that satisfy the JSON Schema below. Do not invent missing required values.
If a required value cannot be inferred safely, omit toolProposal and return:
{"userNeed":"...","goal":"...","clarification":{"blockingReason":"...","question":"one specific question in the user's language"}}

This is not execution authority. Runtime will revalidate the tool name, schema, resource boundary, permission and side effects. Never propose another tool or more than one call.

Tool: ${instruction.tool.description}
Input JSON Schema: ${JSON.stringify(instruction.schema)}`;
}

/** Expand the compact model shape into the existing Runtime-owned DECIDE contract. */
export function expandCompactExplicitToolDecision(
  decision: CompactExplicitToolDecision,
  instruction: ExplicitSingleToolInstruction,
): DecodedPlan {
  const userNeed = cleanText(decision.userNeed);
  const goal = cleanText(decision.goal) ?? userNeed;
  const criterion = cleanText(decision.successCriterion);
  const question = cleanText(decision.clarification?.question);
  const blockingReason = cleanText(decision.clarification?.blockingReason);
  const proposal = decision.toolProposal;
  if (question || blockingReason || !proposal) {
    return {
      assessment: {
        userNeed,
        complexity: 'simple',
        goal,
        successCriteria: criterion ? [criterion] : undefined,
        missingInfo: question ? [question] : undefined,
        needsClarification: true,
        requiresTaskBook: false,
        maxExtraScopeRatio: 1,
      },
      clarification: {
        blockingReason,
        questions: question ? [{ field: 'toolInput', prompt: question, required: true }] : [],
      },
      taskBook: { goal, complexity: 'simple', successCriteria: criterion ? [criterion] : [], steps: [] },
    };
  }
  const title = cleanText(decision.title) ?? goal;
  const description = cleanText(decision.description) ?? goal;
  return {
    assessment: {
      userNeed,
      complexity: 'trivial',
      goal,
      successCriteria: criterion ? [criterion] : undefined,
      missingInfo: [],
      needsClarification: false,
      requiresTaskBook: false,
      maxExtraScopeRatio: 1,
    },
    taskBook: {
      goal,
      complexity: 'trivial',
      successCriteria: criterion ? [criterion] : [],
      steps: [{
        id: 'step-1',
        title,
        description,
        tools: [instruction.tool.name],
        toolProposal: { name: proposal.name, input: proposal.input },
        acceptanceCriteria: criterion ? [criterion] : undefined,
        expectedOutput: cleanText(decision.expectedOutput),
      }],
    },
  };
}

function cleanText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
