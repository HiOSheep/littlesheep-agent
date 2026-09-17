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
  summary?: string;
  successCriterion?: string;
  input?: unknown;
  /** Legacy fields remain readable while older Provider responses age out. */
  userNeed?: string;
  goal?: string;
  title?: string;
  description?: string;
  expectedOutput?: string;
  toolProposal?: { name?: unknown; input?: unknown };
  clarification?: { blockingReason?: string; question?: string };
}

type SelfContainedCompactContext = Pick<
  RunContext,
  | 'inbound'
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
>;

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
  return isSelfContainedCompactTaskContext(ctx);
}

/** Shared conservative gate for compact calls that intentionally omit history and memory. */
export function isSelfContainedCompactTaskContext(
  ctx: SelfContainedCompactContext,
  options: { allowTaskBook?: boolean } = {},
): boolean {
  if ((ctx.attachments?.length ?? 0) > 0
    || (!options.allowTaskBook && ctx.taskBook)
    || ctx.partialReplanRequest
    || ctx.verifyFeedback
    || (ctx.deferredRuntimeEvents?.length ?? 0) > 0
    || ctx.clarificationResponse
    || ctx.initialMemoryContext?.trim()
    || ctx.memoryKnownState?.references.some((reference) => reference.decision !== 'excluded')
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
  return `# Explicit Tool Input

The Runtime locked one built-in tool: \`${instruction.tool.name}\` (${instruction.tool.description}).
From the current user message only, return raw JSON and no markdown:
{"input":{}}

Fill input with concrete values satisfying the schema. Never invent a missing required value. If one cannot be inferred safely, return only:
{"clarification":{"blockingReason":"short reason","question":"one specific question in the user's language"}}

Do not return a tool name, plan, summary, criterion, or multiple calls. Runtime revalidates the schema, workspace boundary, permission, and side effects before execution.

Schema: ${JSON.stringify(instruction.schema)}`;
}

/** Expand the compact model shape into the existing Runtime-owned DECIDE contract. */
export function expandCompactExplicitToolDecision(
  decision: CompactExplicitToolDecision,
  instruction: ExplicitSingleToolInstruction,
  inboundText?: string,
): DecodedPlan {
  const summary = cleanText(decision.summary)
    ?? cleanText(decision.goal)
    ?? cleanText(decision.userNeed)
    ?? cleanText(decision.title)
    ?? cleanText(decision.description)
    ?? cleanText(inboundText)
    ?? `Use ${instruction.tool.name}`;
  const userNeed = cleanText(decision.userNeed) ?? summary;
  const goal = cleanText(decision.goal) ?? summary;
  const criterion = cleanText(decision.successCriterion);
  const question = cleanText(decision.clarification?.question);
  const blockingReason = cleanText(decision.clarification?.blockingReason);
  const legacyProposal = decision.toolProposal;
  const hasDirectInput = hasOwn(decision, 'input');
  const hasLegacyInput = Boolean(legacyProposal && hasOwn(legacyProposal, 'input'));
  const input = hasDirectInput ? decision.input : legacyProposal?.input;
  if (question || blockingReason || (!hasDirectInput && !hasLegacyInput)) {
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
  // Validate while still inside the bounded structured-output retry. The
  // ToolExecutionService repeats this check at dispatch because this proposal
  // is never execution authority.
  const validatedInput = instruction.tool.inputSchema.parse(input);
  const title = cleanText(decision.title) ?? summary;
  const description = cleanText(decision.description) ?? summary;
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
        toolProposal: { name: instruction.tool.name, input: validatedInput },
        acceptanceCriteria: criterion ? [criterion] : undefined,
        expectedOutput: cleanText(decision.expectedOutput) ?? criterion,
      }],
    },
  };
}

function cleanText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
