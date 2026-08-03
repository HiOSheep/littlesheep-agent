import type { AgentTool, RunContext, TaskBook } from '@littlesheep/types';
import { isSelfContainedCompactTaskContext } from './compact-explicit-tool-decision.js';
import { resolveExplicitSingleToolInstruction } from './explicit-tool-instruction.js';

const COMPACT_AUTONOMOUS_READ_TOOLS = new Set(['glob', 'grep', 'read']);
const READ_ONLY_INTENT_PATTERNS: readonly RegExp[] = [
  /(?:查看|列出|显示|读取|查找|搜索|检索|统计|确认|检查|告诉我).{0,40}(?:工作区|目录|文件夹|文件|路径|条目|内容|名称|数量)/u,
  /(?:工作区|目录|文件夹|文件|路径|条目|内容).{0,40}(?:有哪些|是什么|多少|列出|查看|显示|查找|搜索|读取|统计)/u,
  /\b(?:list|show|inspect|read|find|search|count|check)\b.{0,80}\b(?:workspace|directory|folder|file|path|entry|entries|content|name|names)\b/iu,
];
const MUTATING_INTENT_PATTERN = /(?:修改|写入|创建|新建|删除|移除|重命名|移动|复制|执行|运行|安装|更新|提交|推送|下载|上传|保存|编辑|修复|调整|替换)|\b(?:write|edit|modify|create|delete|remove|rename|move|copy|execute|run|install|update|commit|push|download|upload|save|fix|replace)\b/iu;
const NEGATED_MUTATION_PATTERN = /(?:不要|请勿|无需|不需要|禁止)\s*(?:修改|写入|创建|新建|删除|移除|重命名|移动|复制|执行|运行|安装|更新|提交|推送|下载|上传|保存|编辑|修复|调整|替换)|\b(?:do\s+not|don't|without)\s+(?:write|edit|modify|create|delete|remove|rename|move|copy|execute|run|install|update|commit|push|download|upload|save|fix|replace)\b/giu;

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

/** Revalidate the model-authored TaskBook before omitting unrelated execution Context. */
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
  if (step.toolProposal
    || step.requiresApproval
    || !step.tools?.length
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

export function renderCompactAutonomousReadDecisionContract(tools: readonly AgentTool[]): string {
  const names = tools.map((tool) => tool.name);
  const catalog = tools.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n');
  return `# Compact Read-Only Decision

The user supplied a fresh, self-contained workspace inspection request. Choose the smallest sufficient read-only TaskBook while preserving the user's language and active SOUL voice.

Available read tools:
${catalog}

Return raw JSON and no markdown:
{"assessment":{"userNeed":"...","complexity":"trivial|simple","goal":"...","successCriteria":["..."],"missingInfo":[],"needsClarification":false,"requiresTaskBook":false,"maxExtraScopeRatio":1,"rationale":"..."},"taskBook":{"goal":"...","complexity":"trivial|simple","successCriteria":["..."],"overdeliveryPolicy":{"maxExtraScopeRatio":1,"guidance":"stay within the requested read-only scope"},"steps":[{"id":"step-1","title":"...","description":"...","tools":["toolName"],"requiresApproval":false,"execution":{"mode":"serial","resources":[{"key":"workspace:relative/path","mode":"read"}],"sideEffect":"read"},"acceptanceCriteria":["..."],"expectedOutput":"..."}]}}

Rules:
- Select only the read tools needed from: ${names.join(', ')}.
- Do not return toolProposal or tool input. The Provider tool loop chooses concrete calls during EXECUTE.
- Keep exactly one step. Do not add writes, commands, downloads, external actions, memory work, or unrelated analysis.
- If a required path or search target is genuinely missing, return needsClarification=true with one focused clarification question instead of guessing.
- Runtime still revalidates tool schemas, paths, permissions, results, and completion evidence.`;
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
