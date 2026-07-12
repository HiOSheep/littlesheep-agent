// @littlesheep/harness - stages/execute.ts
// EXECUTE: tool-calling execution. Legacy runs still use the global tool loop;
// task-book runs execute step by step and record per-step outcomes.

import { randomUUID } from 'node:crypto';
import type {
  RunContext,
  StageResult,
  AgentTool,
  ToolCall,
  ToolResult,
  PlanStep,
  TaskBook,
  TaskStepResult,
  TaskExecutionResult,
  TaskStepFailureKind,
} from '@littlesheep/types';
import type {
  LlmClient,
  ChatMessage,
  ChatResponse,
  ToolSpec,
  ToolCall as LlmToolCall,
} from '@littlesheep/llm';
import { zodToJsonSchema } from '@littlesheep/llm';
import { appendSystemPromptAddons } from '../profile-prompt.js';
import type { z } from 'zod';
import type { Config } from '@littlesheep/config';
import type { BrandingConfig } from '@littlesheep/branding';
import { assembleSystemPrompt, resolvePromptConfig } from '@littlesheep/prompt';
import { sanitizeOutput } from '@littlesheep/tools';
import { toChatMessage, textOf, userChatMessage } from './_shared.js';

export interface ExecuteStageDeps {
  llm: LlmClient;
  model: string;
  config: Config;
  branding: BrandingConfig;
}

/** Max LLM->tool round-trips before forcing RECOVER. */
const MAX_ITERATIONS = 20;

/** Max identical tool calls (same name + args) before refusing to re-execute. */
const MAX_REPEAT = 3;

/** Per-tool execution timeout (ms). Guards against hung tools (e.g. exec on stdin). */
const TOOL_TIMEOUT_MS = 60_000;

interface ToolLoopResult {
  ok: boolean;
  content: string;
  toolResults: ToolResult[];
  iterations: number;
  usage?: ChatResponse['usage'];
  error?: string;
}

interface ToolLoopOptions {
  ctx: RunContext;
  messages: ChatMessage[];
  tools: AgentTool[];
  sanitizeOpts: { maxOutputChars: number; stripImages: boolean };
  stepId?: string;
}

/** JSON.stringify that never throws (defends against circular refs / non-serializable output). */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '[non-serializable]';
  }
}

function stampStepMeta(result: ToolResult, stepId?: string): ToolResult {
  if (!stepId) return result;
  return {
    ...result,
    meta: { ...(result.meta ?? {}), stepId },
  };
}

/**
 * Race a promise against a timeout + abort signal. Rejects on timeout/abort so
 * a hung tool can't block the loop indefinitely. The caller catches the reject.
 */
function raceWithTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`tool timed out after ${ms}ms`)), ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error('aborted')); };
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); reject(new Error('aborted')); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    p.then(
      (v) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/** Bridge an OpenAI-format ToolCall to the internal {id, name, input} shape. */
export function convertToolCall(tc: LlmToolCall): { id: string; name: string; input: unknown } {
  let input: unknown;
  try {
    input = JSON.parse(tc.function.arguments || '{}');
  } catch {
    input = {};
  }
  return { id: tc.id, name: tc.function.name, input };
}

/** Build an OpenAI ToolSpec from an AgentTool. Prefers jsonSchema, falls back to zod conversion. */
function toolToSpec(tool: AgentTool): ToolSpec {
  const explicit = tool.inputSchema.jsonSchema;
  const params = explicit
    ? (explicit as object)
    : zodToJsonSchema(tool.inputSchema as unknown as z.ZodTypeAny);
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: params },
  };
}

/** Render the plan (from DECIDE) as a system-prompt guidance block. */
function renderPlanGuidance(plan: PlanStep[]): string {
  const lines = plan.map((step, i) => {
    const tools = step.tools && step.tools.length > 0 ? ` [tools: ${step.tools.join(', ')}]` : '';
    const ap = step.requiresApproval ? ' (needs approval)' : '';
    return `${i + 1}. ${step.description}${tools}${ap}`;
  });
  return `\n\n---\n\nProposed plan (from DECIDE):\n${lines.join('\n')}`;
}

/** Render the structured task book as the execution contract for this run. */
function renderTaskBookGuidance(taskBook: TaskBook): string {
  const criteria = taskBook.successCriteria.length > 0
    ? taskBook.successCriteria.map((c) => `- ${c}`).join('\n')
    : '- Satisfy the calibrated user goal.';
  const lines = taskBook.steps.map((step, i) => {
    const label = step.title ? `${step.title}: ` : '';
    const tools = step.tools && step.tools.length > 0 ? ` [tools: ${step.tools.join(', ')}]` : '';
    const ap = step.requiresApproval ? ' (needs approval)' : '';
    const stepCriteria = step.acceptanceCriteria && step.acceptanceCriteria.length > 0
      ? `\n     acceptance: ${step.acceptanceCriteria.join('; ')}`
      : '';
    const expected = step.expectedOutput ? `\n     expected: ${step.expectedOutput}` : '';
    return `${i + 1}. ${label}${step.description}${tools}${ap}${stepCriteria}${expected}`;
  });
  return `\n\n---\n\nTask book (from DECIDE):
Goal: ${taskBook.goal}
Complexity: ${taskBook.complexity}
Overdelivery limit: ${taskBook.overdeliveryPolicy.maxExtraScopeRatio}x
Overdelivery guidance: ${taskBook.overdeliveryPolicy.guidance}
Success criteria:
${criteria}

Steps:
${lines.join('\n')}

Execution rules:
- Keep work proportional to the calibrated complexity.
- Do not exceed the overdelivery limit; avoid doing broad extra work unless it directly improves the goal.
- When the task is trivial/simple, prefer the shortest sufficient route.
- When evidence is needed, use tools to verify before claiming success.`;
}

function renderStepGuidance(
  taskBook: TaskBook,
  step: PlanStep,
  stepId: string,
  index: number,
  total: number,
  previousResults: TaskStepResult[],
): string {
  const criteria = step.acceptanceCriteria && step.acceptanceCriteria.length > 0
    ? step.acceptanceCriteria.map((c) => `- ${c}`).join('\n')
    : '- Complete the described step well enough to advance the task.';
  const previous = previousResults.length > 0
    ? previousResults.map((r, i) => `${i + 1}. ${r.title ?? r.stepId}: ${truncateText(r.output ?? r.error ?? r.status, 600)}`).join('\n')
    : '(none)';
  return `\n\n---\n\nStep execution contract:
You are executing exactly one task-book step.
Task goal: ${taskBook.goal}
Current step: ${index + 1}/${total}
Step id: ${stepId}
Step title: ${step.title ?? '(untitled)'}
Step description: ${step.description}
Step acceptance criteria:
${criteria}
Expected output: ${step.expectedOutput ?? '(not specified)'}
Previous step results:
${previous}

Instructions:
- Complete only this step.
- Use tools when they reduce uncertainty or are required by the step.
- Return a concise step result when the step is complete.
- Do not claim the whole task is complete unless this is the final step.`;
}

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...[truncated]`;
}

/** Stage-level approval gate. Tools that self-gate (e.g. exec) still run their own internal checks. */
async function checkStageApproval(
  tool: AgentTool,
  input: unknown,
  ctx: RunContext,
): Promise<{ ok: boolean; reason?: string }> {
  if (!tool.requiresApproval) return { ok: true };
  const approve = ctx.toolContext.approve;
  if (!approve) return { ok: false, reason: 'approval unavailable' };
  try {
    const allowed = await approve(tool.name, input);
    return allowed ? { ok: true } : { ok: false, reason: 'denied by approval gate' };
  } catch (err) {
    return { ok: false, reason: `approval error: ${(err as Error).message}` };
  }
}

/** Push an assistant tool_calls Message to ctx.produced for session persistence. */
function persistToolCalls(ctx: RunContext, calls: ToolCall[]): void {
  ctx.produced.push({
    id: randomUUID(),
    role: 'assistant',
    content: [{ type: 'tool_calls', calls }],
    timestamp: new Date().toISOString(),
    sessionId: ctx.sessionId,
    runId: ctx.runId,
    stage: 'execute',
  });
}

/** Push a tool tool_result Message to ctx.produced for session persistence. */
function persistToolResult(ctx: RunContext, tr: ToolResult): void {
  ctx.produced.push({
    id: randomUUID(),
    role: 'tool',
    content: [{ type: 'tool_result', result: tr }],
    timestamp: new Date().toISOString(),
    sessionId: ctx.sessionId,
    runId: ctx.runId,
    stage: 'execute',
  });
}

async function runToolLoop(
  deps: ExecuteStageDeps,
  opts: ToolLoopOptions,
): Promise<ToolLoopResult> {
  const { ctx, messages, tools, sanitizeOpts, stepId } = opts;
  const toolSpecs = tools.map(toolToSpec);
  const toolResults: ToolResult[] = [];
  const repeatMap = new Map<string, number>();

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    let res: ChatResponse;
    try {
      res = await deps.llm.chat({
        model: deps.model,
        messages,
        tools: toolSpecs.length > 0 ? toolSpecs : undefined,
        tool_choice: toolSpecs.length > 0 ? 'auto' : undefined,
        temperature: 0,
        signal: ctx.signal,
      });
    } catch (err) {
      return {
        ok: false,
        content: '',
        toolResults,
        iterations: iter,
        error: `llm call failed: ${(err as Error).message}`,
      };
    }

    if (res.finishReason === 'stop') {
      return {
        ok: true,
        content: res.content,
        toolResults,
        iterations: iter,
        usage: res.usage,
      };
    }

    if (res.finishReason === 'tool_calls' && res.toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: res.content,
        tool_calls: res.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      });

      persistToolCalls(ctx, res.toolCalls.map(convertToolCall));

      for (const tc of res.toolCalls) {
        const { id, name, input } = convertToolCall(tc);
        const tool = tools.find((t) => t.name === name);

        if (!tool) {
          const tr = stampStepMeta({ callId: id, ok: false, error: `unknown tool: ${name}` }, stepId);
          toolResults.push(tr);
          persistToolResult(ctx, tr);
          messages.push({
            role: 'tool',
            tool_call_id: id,
            name,
            content: safeStringify({ ok: false, error: tr.error }),
          });
          ctx.onToolEvent?.({ type: 'tool_end', callId: id, name, stepId, ok: false, error: tr.error });
          continue;
        }

        const ap = await checkStageApproval(tool, input, ctx);
        if (!ap.ok) {
          const tr = stampStepMeta({ callId: id, ok: false, error: ap.reason }, stepId);
          toolResults.push(tr);
          persistToolResult(ctx, tr);
          messages.push({
            role: 'tool',
            tool_call_id: id,
            name,
            content: safeStringify({ ok: false, error: ap.reason }),
          });
          ctx.onToolEvent?.({ type: 'tool_end', callId: id, name, stepId, ok: false, error: ap.reason });
          continue;
        }

        const callKey = `${name}:${safeStringify(input)}`;
        const repeatCount = (repeatMap.get(callKey) ?? 0) + 1;
        repeatMap.set(callKey, repeatCount);
        if (repeatCount > MAX_REPEAT) {
          const reason = `repeated identical call (${repeatCount}x) - refusing to re-execute; try different arguments or stop`;
          const tr = stampStepMeta({ callId: id, ok: false, error: reason }, stepId);
          toolResults.push(tr);
          persistToolResult(ctx, tr);
          messages.push({
            role: 'tool',
            tool_call_id: id,
            name,
            content: safeStringify({ ok: false, error: reason }),
          });
          ctx.onToolEvent?.({ type: 'tool_end', callId: id, name, stepId, ok: false, error: reason });
          continue;
        }

        let tr: ToolResult;
        try {
          ctx.onToolEvent?.({ type: 'tool_start', callId: id, name: tool.name, stepId, input });
          tr = await raceWithTimeout(
            tool.execute(input, ctx.toolContext),
            TOOL_TIMEOUT_MS,
            ctx.signal,
          );
        } catch (err) {
          tr = { callId: id, ok: false, error: (err as Error).message };
        }
        tr.callId = id;

        if (tr.output !== undefined && typeof tr.output !== 'undefined') {
          const s = sanitizeOutput(tr.output, sanitizeOpts);
          tr.output = s.output;
          tr.sanitized = s.sanitized || tr.sanitized === true;
        }
        tr = stampStepMeta(tr, stepId);

        ctx.onToolEvent?.({
          type: 'tool_end',
          callId: id,
          name: tool.name,
          stepId,
          ok: tr.ok,
          output: tr.ok && tr.output !== undefined ? String(tr.output).slice(0, 400) : undefined,
          error: tr.error,
        });

        toolResults.push(tr);
        persistToolResult(ctx, tr);
        messages.push({
          role: 'tool',
          tool_call_id: id,
          name,
          content: safeStringify(tr.ok ? tr.output : { ok: false, error: tr.error }),
        });
      }
      continue;
    }

    return {
      ok: false,
      content: '',
      toolResults,
      iterations: iter,
      error: `llm finishReason: ${res.finishReason}`,
    };
  }

  return {
    ok: false,
    content: '',
    toolResults,
    iterations: MAX_ITERATIONS,
    error: `tool loop exceeded ${MAX_ITERATIONS} iterations`,
  };
}

function applyUsage(ctx: RunContext, usage: ChatResponse['usage'] | undefined): void {
  if (!usage) return;
  ctx.usage = {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens ?? usage.promptTokens + usage.completionTokens,
    source: 'provider',
  };
}

function resolveStepId(step: PlanStep, index: number): string {
  return step.id ?? `step-${index + 1}`;
}

function pickStepTools(step: PlanStep, tools: AgentTool[]): AgentTool[] {
  if (!step.tools || step.tools.length === 0) return tools;
  const names = new Set(step.tools);
  const picked = tools.filter((tool) => names.has(tool.name));
  return picked.length > 0 ? picked : tools;
}

function hasBlockingToolFailure(results: ToolResult[]): boolean {
  let lastFailureIndex = -1;
  for (let i = results.length - 1; i >= 0; i--) {
    if (!results[i]!.ok) {
      lastFailureIndex = i;
      break;
    }
  }
  if (lastFailureIndex < 0) return false;
  return !results.slice(lastFailureIndex + 1).some((result) => result.ok);
}

function blockingToolFailureReason(results: ToolResult[]): string {
  const failed = [...results].reverse().find((result) => !result.ok);
  return failed?.error ?? 'tool failed without a reported reason';
}

function classifyStepFailure(error: string | undefined, results: ToolResult[]): TaskStepFailureKind {
  const text = [error, ...results.filter((result) => !result.ok).map((result) => result.error)]
    .filter((value): value is string => !!value)
    .join(' ')
    .toLowerCase();
  if (/denied|approval|permission/.test(text)) return 'permission_denied';
  if (/enoent|not found|cannot find|does not exist|no such file/.test(text)) return 'not_found';
  if (/abort|cancelled|canceled/.test(text)) return 'aborted';
  if (/llm call|finishreason|tool loop exceeded|model/.test(text)) return 'model_error';
  if (results.some((result) => !result.ok)) return 'tool_error';
  return 'unknown';
}

function orderedStepResults(taskBook: TaskBook, results: Map<string, TaskStepResult>): TaskStepResult[] {
  return taskBook.steps
    .map((step, index) => results.get(resolveStepId(step, index)))
    .filter((result): result is TaskStepResult => !!result);
}

function buildBaseMessages(ctx: RunContext, systemMsg: string): ChatMessage[] {
  return [
    { role: 'system', content: systemMsg },
    ...ctx.history.map(toChatMessage),
    userChatMessage(textOf(ctx.inbound), ctx.attachments),
  ];
}

async function synthesizeFinalReply(
  deps: ExecuteStageDeps,
  ctx: RunContext,
  taskBook: TaskBook,
  stepResults: TaskStepResult[],
): Promise<string> {
  if (stepResults.length === 1) {
    return stepResults[0]?.output ?? '';
  }

  const stepSummary = stepResults.map((step, i) =>
    `${i + 1}. ${step.title ?? step.stepId} [${step.status}]\n`
    + `Description: ${step.description}\n`
    + `Output: ${step.output ?? '(no output)'}\n`
    + (step.error ? `Error: ${step.error}\n` : ''),
  ).join('\n');

  try {
    const res = await deps.llm.chat({
      model: deps.model,
      messages: [
        {
          role: 'system',
          content: appendSystemPromptAddons(
            `You are the final response assembler. Produce the final user-facing answer from completed task-book step results.
Keep it concise, truthful, and proportional to the user's request. Do not claim failed steps succeeded.`,
            ctx.profilePromptAddon,
            ctx.reasoningPromptAddon,
          ),
        },
        {
          role: 'user',
          content:
            `Original request:\n${textOf(ctx.inbound)}\n\n`
            + `Task goal:\n${taskBook.goal}\n\n`
            + `Success criteria:\n${taskBook.successCriteria.map((c) => `- ${c}`).join('\n')}\n\n`
            + `Step results:\n${stepSummary}\n\n`
            + `Write the final reply in the user's language.`,
        },
      ],
      temperature: 0,
      max_tokens: 900,
      signal: ctx.signal,
    });
    applyUsage(ctx, res.usage);
    return res.content.trim() || stepResults.map((step) => step.output).filter(Boolean).join('\n\n');
  } catch {
    return stepResults
      .map((step) => step.output)
      .filter((output): output is string => !!output && output.trim().length > 0)
      .join('\n\n');
  }
}

async function executeLegacyLoop(
  deps: ExecuteStageDeps,
  ctx: RunContext,
  systemMsg: string,
  sanitizeOpts: { maxOutputChars: number; stripImages: boolean },
): Promise<StageResult> {
  const result = await runToolLoop(deps, {
    ctx,
    messages: buildBaseMessages(ctx, systemMsg),
    tools: ctx.tools,
    sanitizeOpts,
  });

  ctx.toolResults = result.toolResults;
  if (!result.ok) {
    ctx.lastError = { stage: 'execute', message: result.error ?? 'execute failed' };
    return { stage: 'execute', next: 'recover', ok: false, error: ctx.lastError.message };
  }

  ctx.reply = result.content;
  applyUsage(ctx, result.usage);
  return {
    stage: 'execute',
    next: 'verify',
    ok: true,
    meta: { iterations: result.iterations, toolCalls: result.toolResults.length },
  };
}

async function executeTaskBook(
  deps: ExecuteStageDeps,
  ctx: RunContext,
  baseSystemPrompt: string,
  taskBook: TaskBook,
  sanitizeOpts: { maxOutputChars: number; stripImages: boolean },
): Promise<StageResult> {
  const startedAt = new Date().toISOString();
  const previousExecution = ctx.taskExecution?.goal === taskBook.goal ? ctx.taskExecution : undefined;
  const resumeRequest = ctx.partialReplanRequest;
  const resumeTargets = new Set(resumeRequest?.targetStepIds ?? []);
  const previousById = new Map((previousExecution?.steps ?? []).map((step) => [step.stepId, step]));
  const resultsById = new Map<string, TaskStepResult>(
    (previousExecution?.steps ?? []).map((step) => [step.stepId, { ...step, toolResults: [...step.toolResults] }]),
  );
  const execution: TaskExecutionResult = {
    goal: taskBook.goal,
    complexity: taskBook.complexity,
    status: 'running',
    startedAt: previousExecution?.startedAt ?? startedAt,
    steps: orderedStepResults(taskBook, resultsById),
    replanHistory: ctx.replanHistory ?? previousExecution?.replanHistory,
  };
  ctx.taskExecution = execution;
  taskBook.stageResults = execution.steps;

  const allToolResults: ToolResult[] = (previousExecution?.steps ?? [])
    .filter((step) => step.status === 'done' && !resumeTargets.has(step.stepId))
    .flatMap((step) => step.toolResults);

  if (resumeRequest) {
    const record = [...(ctx.replanHistory ?? [])]
      .reverse()
      .find((item) => item.attempt === resumeRequest.attempt && item.requestedAt === resumeRequest.requestedAt);
    if (record) record.resumedAt = startedAt;
  }
  ctx.partialReplanRequest = undefined;

  const syncExecutionSteps = () => {
    execution.steps = orderedStepResults(taskBook, resultsById);
    taskBook.stageResults = execution.steps;
  };

  for (let i = 0; i < taskBook.steps.length; i++) {
    const step = taskBook.steps[i]!;
    const stepId = resolveStepId(step, i);
    const previousResult = previousById.get(stepId);

    if (previousResult?.status === 'done' && !resumeTargets.has(stepId)) {
      step.status = 'done';
      ctx.onToolEvent?.({
        type: 'step_skipped',
        stepId,
        title: step.title,
        description: step.description,
        status: 'done',
        summary: 'Preserved from a previous execution attempt.',
      });
      continue;
    }

    const stepStartedAt = new Date().toISOString();
    step.status = 'in_progress';

    const stepResult: TaskStepResult = {
      stepId,
      title: step.title,
      description: step.description,
      status: 'in_progress',
      startedAt: stepStartedAt,
      acceptanceCriteria: step.acceptanceCriteria,
      expectedOutput: step.expectedOutput,
      attempt: (previousResult?.attempt ?? (previousResult ? 1 : 0)) + 1,
      toolCallIds: [],
      toolResults: [],
    };
    resultsById.set(stepId, stepResult);
    syncExecutionSteps();

    ctx.onToolEvent?.({
      type: 'step_start',
      stepId,
      title: step.title,
      description: step.description,
      status: 'in_progress',
    });

    const stepSystemMsg = baseSystemPrompt
      + renderStepGuidance(
        taskBook,
        step,
        stepId,
        i,
        taskBook.steps.length,
        taskBook.steps
          .slice(0, i)
          .map((priorStep, priorIndex) => resultsById.get(resolveStepId(priorStep, priorIndex)))
          .filter((result): result is TaskStepResult => !!result),
      );
    const loopResult = await runToolLoop(deps, {
      ctx,
      messages: buildBaseMessages(ctx, stepSystemMsg),
      tools: pickStepTools(step, ctx.tools),
      sanitizeOpts,
      stepId,
    });

    allToolResults.push(...loopResult.toolResults);
    stepResult.toolResults = loopResult.toolResults;
    stepResult.toolCallIds = loopResult.toolResults.map((result) => result.callId);
    stepResult.endedAt = new Date().toISOString();

    if (!loopResult.ok) {
      step.status = 'failed';
      stepResult.status = 'failed';
      stepResult.error = loopResult.error ?? 'step failed';
      stepResult.failureKind = classifyStepFailure(stepResult.error, loopResult.toolResults);
      execution.status = 'failed';
      execution.endedAt = new Date().toISOString();
      syncExecutionSteps();
      ctx.toolResults = allToolResults;
      ctx.reply = stepResult.error;
      ctx.lastError = { stage: 'execute', message: stepResult.error };
      ctx.onToolEvent?.({
        type: 'step_failed',
        stepId,
        title: step.title,
        description: step.description,
        status: 'failed',
        error: stepResult.error,
      });
      return {
        stage: 'execute',
        next: 'recover',
        ok: false,
        error: stepResult.error,
        meta: { taskStatus: execution.status, failedStepId: stepId },
      };
    }

    stepResult.output = loopResult.content.trim();
    applyUsage(ctx, loopResult.usage);

    if (hasBlockingToolFailure(loopResult.toolResults)) {
      stepResult.error = blockingToolFailureReason(loopResult.toolResults);
      stepResult.failureKind = classifyStepFailure(stepResult.error, loopResult.toolResults);
      const blocked = stepResult.failureKind === 'permission_denied';
      step.status = blocked ? 'blocked' : 'failed';
      stepResult.status = blocked ? 'blocked' : 'failed';
      execution.status = blocked ? 'blocked' : 'failed';
      execution.endedAt = new Date().toISOString();
      syncExecutionSteps();
      ctx.toolResults = allToolResults;
      ctx.reply = stepResult.output || stepResult.error;
      ctx.onToolEvent?.({
        type: 'step_failed',
        stepId,
        title: step.title,
        description: step.description,
        status: 'failed',
        output: stepResult.output,
        error: stepResult.error,
      });
      return {
        stage: 'execute',
        next: 'verify',
        ok: true,
        meta: { taskStatus: execution.status, failedStepId: stepId, toolCalls: allToolResults.length },
      };
    }

    step.status = 'done';
    stepResult.status = 'done';
    syncExecutionSteps();
    ctx.onToolEvent?.({
      type: 'step_done',
      stepId,
      title: step.title,
      description: step.description,
      status: 'done',
      output: stepResult.output,
    });
  }

  execution.status = 'done';
  execution.endedAt = new Date().toISOString();
  syncExecutionSteps();
  ctx.toolResults = allToolResults;
  ctx.reply = await synthesizeFinalReply(deps, ctx, taskBook, execution.steps);
  execution.summary = ctx.reply;
  ctx.lastError = undefined;

  return {
    stage: 'execute',
    next: 'verify',
    ok: true,
    meta: {
      taskStatus: execution.status,
      taskSteps: execution.steps.length,
      toolCalls: allToolResults.length,
    },
  };
}

/** Factory: creates an execute stage. */
export function createExecuteStage(deps: ExecuteStageDeps) {
  return async function executeStage(ctx: RunContext): Promise<StageResult> {
    const resolved = resolvePromptConfig(deps.config, deps.branding);
    const systemPrompt = await assembleSystemPrompt(resolved, {
      tools: ctx.tools,
      bootstrap: ctx.bootstrap ?? {},
      prelude: ctx.prelude,
      memoryRootIndex: ctx.memoryRootIndex,
    });
    const planGuidance = ctx.taskBook
      ? renderTaskBookGuidance(ctx.taskBook)
      : ctx.plan && ctx.plan.length > 0
        ? renderPlanGuidance(ctx.plan)
        : '';

    const systemMsg = appendSystemPromptAddons(
      systemPrompt + planGuidance,
      ctx.profilePromptAddon,
      ctx.reasoningPromptAddon,
    );
    const sanitizeOpts = {
      maxOutputChars: deps.config.tools.maxOutputChars,
      stripImages: deps.config.tools.stripImages,
    };

    if (ctx.taskBook && ctx.taskBook.steps.length > 0) {
      return executeTaskBook(deps, ctx, systemMsg, ctx.taskBook, sanitizeOpts);
    }

    return executeLegacyLoop(deps, ctx, systemMsg, sanitizeOpts);
  };
}
