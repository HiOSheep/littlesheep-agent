import type { AgentTool, RunContext, TaskBook } from '@littlesheep/types';
import { isSelfContainedCompactTaskContext } from './compact-explicit-tool-decision.js';
import {
  resolveBoundedToolJsonSchema,
  resolveExplicitSingleToolInstruction,
} from './explicit-tool-instruction.js';
import type { DecodedPlan } from './stages/decide/contracts.js';

const COMPACT_AUTONOMOUS_READ_TOOLS = new Set(['glob', 'grep', 'read']);
const READ_ONLY_INTENT_PATTERNS: readonly RegExp[] = [
  /(?:查看|列出|显示|读取|查找|搜索|检索|统计|确认|检查|告诉我).{0,40}(?:工作区|目录|文件夹|文件|路径|条目|内容|名称|数量)/u,
  /(?:工作区|目录|文件夹|文件|路径|条目|内容).{0,40}(?:有哪些|是什么|多少|列出|查看|显示|查找|搜索|读取|统计)/u,
  /\b(?:list|show|inspect|read|find|search|count|check)\b.{0,80}\b(?:workspace|directory|folder|file|path|entry|entries|content|name|names)\b/iu,
];
const MUTATING_INTENT_PATTERN = /(?:修改|写入|创建|新建|删除|移除|重命名|移动|复制|执行|运行|安装|更新|提交|推送|下载|上传|保存|编辑|修复|调整|替换)|\b(?:write|edit|modify|create|delete|remove|rename|move|copy|execute|run|install|update|commit|push|download|upload|save|fix|replace)\b/iu;
const NEGATED_MUTATION_PATTERN = /(?:不要|请勿|无需|不需要|禁止)\s*(?:修改|写入|创建|新建|删除|移除|重命名|移动|复制|执行|运行|安装|更新|提交|推送|下载|上传|保存|编辑|修复|调整|替换)|\b(?:do\s+not|don't|without)\s+(?:write|edit|modify|create|delete|remove|rename|move|copy|execute|run|install|update|commit|push|download|upload|save|fix|replace)\b/giu;

export interface CompactAutonomousReadDecision {
  tool?: unknown;
  input?: unknown;
  summary?: unknown;
  successCriterion?: unknown;
  clarification?: {
    blockingReason?: unknown;
    question?: unknown;
  };
}

/** Select the small read-tool catalog for a fresh goal while leaving the choice to the LLM. */
export function resolveCompactAutonomousReadDecisionTools(ctx: RunContext): AgentTool[] | undefined {
  if (ctx.classification?.activity !== 'execute'
    || resolveExplicitSingleToolInstruction(ctx)
    || !isSelfContainedCompactTaskContext(ctx)
    || !hasReadOnlyWorkspaceIntent(inboundText(ctx))) {
    return undefined;
  }
  const tools = builtinReadTools(ctx);
  return tools.length > 0 ? tools : undefined;
}

/** Revalidate the model-authored TaskBook before direct execution or compact fallback execution. */
export function resolveCompactAutonomousReadExecutionTools(ctx: RunContext): AgentTool[] | undefined {
  if (ctx.classification?.activity !== 'execute'
    || !isSelfContainedCompactTaskContext(ctx, { allowTaskBook: true })
    || !hasReadOnlyWorkspaceIntent(inboundText(ctx))) {
    return undefined;
  }
  const taskBook = ctx.taskBook;
  if (!taskBook
    || (taskBook.complexity !== 'trivial' && taskBook.complexity !== 'simple')
    || taskBook.steps.length !== 1) {
    return undefined;
  }
  const step = taskBook.steps[0]!;
  if (step.requiresApproval
    || step.tools?.length !== 1
    || (step.execution?.sideEffect !== undefined
      && step.execution.sideEffect !== 'none'
      && step.execution.sideEffect !== 'read')) {
    return undefined;
  }
  const requested = new Set(step.tools);
  if (requested.size !== step.tools.length
    || [...requested].some((name) => !COMPACT_AUTONOMOUS_READ_TOOLS.has(name))) {
    return undefined;
  }
  const selected = builtinReadTools(ctx).filter((tool) => requested.has(tool.name));
  return selected.length === requested.size ? selected : undefined;
}

/** Resolve the single autonomous proposal that Runtime may attempt to execute directly. */
export function resolveCompactAutonomousReadProposalTool(
  ctx: RunContext,
  taskBook: TaskBook,
  step: TaskBook['steps'][number],
): AgentTool | undefined {
  if (ctx.taskBook !== taskBook || taskBook.steps[0] !== step) return undefined;
  const proposal = step.toolProposal;
  if (!proposal || step.tools?.length !== 1 || step.tools[0] !== proposal.name) return undefined;
  const selected = resolveCompactAutonomousReadExecutionTools(ctx);
  return selected?.length === 1 && selected[0]?.name === proposal.name
    ? selected[0]
    : undefined;
}

export function renderCompactAutonomousReadDecisionContract(tools: readonly AgentTool[]): string {
  const names = tools.map((tool) => tool.name);
  const catalog = tools.map((tool) => {
    const schema = resolveBoundedToolJsonSchema(tool);
    if (!schema) throw new Error(`compact read tool has no bounded schema: ${tool.name}`);
    return `- ${tool.name}: ${tool.description}\n  Input JSON Schema: ${JSON.stringify(schema)}`;
  }).join('\n');
  return `# Compact Read-Only Tool Decision

The user supplied a fresh, self-contained workspace inspection request. Choose exactly one smallest sufficient read-only tool and provide its concrete input.

Available read tools:
${catalog}

Return raw JSON and no markdown:
{"tool":"toolName","input":{},"summary":"one short action summary in the user's language","successCriterion":"one observable result criterion in the user's language"}

Rules:
- Select exactly one tool from: ${names.join(', ')}.
- Fill input with concrete values satisfying that tool's schema. Do not copy an empty object when required fields exist.
- Keep summary and successCriterion concise, evidence-oriented, in the user's language, and consistent with the active SOUL voice.
- Do not add writes, commands, downloads, external actions, memory work, or unrelated analysis.
- If a required path or search target cannot be inferred safely, return only {"clarification":{"blockingReason":"short reason","question":"one focused question in the user's language"}}.
- Runtime still revalidates the selected name, input schema, workspace path, permission, side effects, result, and completion evidence. This response grants no execution authority.`;
}

/** Expand the compact model response into the existing Runtime-owned TaskBook contract. */
export function expandCompactAutonomousReadDecision(
  decision: CompactAutonomousReadDecision,
  tools: readonly AgentTool[],
  inboundText: string,
): DecodedPlan {
  const question = cleanText(decision.clarification?.question);
  const blockingReason = cleanText(decision.clarification?.blockingReason);
  if (question || blockingReason) {
    const prompt = question ?? blockingReason!;
    return {
      assessment: {
        userNeed: inboundText,
        complexity: 'simple',
        goal: inboundText,
        missingInfo: [prompt],
        needsClarification: true,
        requiresTaskBook: false,
        maxExtraScopeRatio: 1,
      },
      clarification: {
        blockingReason,
        questions: question ? [{ field: 'toolInput', prompt: question, required: true }] : [],
      },
      taskBook: { goal: inboundText, complexity: 'simple', successCriteria: [], steps: [] },
    };
  }

  const toolName = cleanText(decision.tool);
  const tool = toolName ? tools.find((candidate) => candidate.name === toolName) : undefined;
  const summary = cleanText(decision.summary);
  const successCriterion = cleanText(decision.successCriterion);
  if (!tool || !summary || !successCriterion) {
    throw new Error('compact autonomous read decision omitted a valid tool, summary, or success criterion');
  }
  const hasInput = hasOwn(decision, 'input');
  return {
    assessment: {
      userNeed: summary,
      complexity: 'trivial',
      goal: summary,
      successCriteria: [successCriterion],
      missingInfo: [],
      needsClarification: false,
      requiresTaskBook: false,
      maxExtraScopeRatio: 1,
    },
    taskBook: {
      goal: summary,
      complexity: 'trivial',
      successCriteria: [successCriterion],
      overdeliveryPolicy: {
        maxExtraScopeRatio: 1,
        guidance: 'stay within the requested read-only scope',
      },
      steps: [{
        id: 'step-1',
        title: summary,
        description: summary,
        tools: [tool.name],
        ...(hasInput ? { toolProposal: { name: tool.name, input: decision.input } } : {}),
        execution: { mode: 'serial', sideEffect: 'read' },
        acceptanceCriteria: [successCriterion],
        expectedOutput: successCriterion,
      }],
    },
  };
}

export function renderCompactAutonomousReadWorkspace(workspace: string): string {
  return `Active LS workspace: ${workspace}\nUse relative tool paths. Runtime resolves and revalidates every path.`;
}

export function renderCompactAutonomousReadTaskGuidance(taskBook: TaskBook): string {
  const step = taskBook.steps[0]!;
  return `Read-only task selected by DECIDE:
Goal: ${taskBook.goal}
Allowed tools: ${step.tools?.join(', ') ?? '(none)'}
Success: ${taskBook.successCriteria.join('; ')}
Use the shortest sufficient route. Runtime owns permissions, paths, execution, and evidence.`;
}

export function renderCompactAutonomousReadStepGuidance(taskBook: TaskBook): string {
  const step = taskBook.steps[0]!;
  return `Execute one self-contained read-only step.
Goal: ${taskBook.goal}
Step: ${step.description}
Acceptance: ${step.acceptanceCriteria?.join('; ') ?? taskBook.successCriteria.join('; ')}
Expected output: ${step.expectedOutput ?? 'a concise evidence-based result'}
Use only the admitted read tools. Return the concise user-facing result in the user's language and active SOUL voice; preserve Runtime facts and do not expose private reasoning.`;
}

function builtinReadTools(ctx: RunContext): AgentTool[] {
  return ctx.tools.filter((tool) => (
    COMPACT_AUTONOMOUS_READ_TOOLS.has(tool.name)
    && ctx.toolSources?.[tool.name] === 'builtin'
  ));
}

function hasReadOnlyWorkspaceIntent(text: string): boolean {
  if (!text.trim()) return false;
  const mutationAware = text.replace(NEGATED_MUTATION_PATTERN, '');
  return !MUTATING_INTENT_PATTERN.test(mutationAware)
    && READ_ONLY_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

function inboundText(ctx: RunContext): string {
  return ctx.inbound.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function cleanText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
