// Owns the bounded model-to-tool loop, approval, timeout and persisted evidence.
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  zodToJsonSchema,
  type ChatResponse,
  type ToolCall as LlmToolCall,
  type ToolSpec,
} from '@littlesheep/llm';
import type {
  AgentTool,
  RunContext,
  ToolCall,
  ToolResult,
} from '@littlesheep/types';
import { sanitizeOutput } from '@littlesheep/tools';
import { buildRunRequestCandidates } from '../../context-candidates.js';
import { prepareModelRequest, recordProviderUsage } from '../../model-observability.js';
import type {
  ExecuteStageDeps,
  ToolLoopOptions,
  ToolLoopResult,
} from './contracts.js';

const MAX_ITERATIONS = 20;
const MAX_REPEAT = 3;
const TOOL_TIMEOUT_MS = 60_000;

export function convertToolCall(tc: LlmToolCall): { id: string; name: string; input: unknown } {
  let input: unknown;
  try {
    input = JSON.parse(tc.function.arguments || '{}');
  } catch {
    input = {};
  }
  return { id: tc.id, name: tc.function.name, input };
}

export async function runToolLoop(
  deps: ExecuteStageDeps,
  opts: ToolLoopOptions,
): Promise<ToolLoopResult> {
  const { ctx, messages, tools, sanitizeOpts, stepId, systemSegments, insertedBeforePrimary } = opts;
  const toolSpecs = tools.map(toolToSpec);
  const toolResults: ToolResult[] = [];
  const repeatMap = new Map<string, number>();

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    let response: ChatResponse;
    try {
      const rawRequest = {
        model: deps.model,
        messages,
        tools: toolSpecs.length > 0 ? toolSpecs : undefined,
        tool_choice: toolSpecs.length > 0 ? 'auto' : undefined,
        temperature: 0,
        signal: ctx.signal,
      } satisfies import('@littlesheep/llm').ChatRequest;
      const request = prepareModelRequest(
        ctx,
        'execute_tool_loop',
        rawRequest,
        buildRunRequestCandidates(ctx, 'execute', rawRequest.messages, {
          systemSegments,
          insertedBeforePrimary,
        }),
      );
      response = await deps.llm.chat(request);
      recordProviderUsage(ctx, request, response.usage);
    } catch (error) {
      return {
        ok: false,
        content: '',
        toolResults,
        iterations: iteration,
        error: `llm call failed: ${(error as Error).message}`,
      };
    }

    if (response.finishReason === 'stop') {
      return {
        ok: true,
        content: response.content,
        toolResults,
        iterations: iteration,
        usage: response.usage,
      };
    }

    if (response.finishReason === 'tool_calls' && response.toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: response.content,
        reasoning_content: response.reasoningContent,
        tool_calls: response.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.function.name, arguments: call.function.arguments },
        })),
      });
      persistToolCalls(ctx, response.toolCalls.map(convertToolCall));

      for (const call of response.toolCalls) {
        const { id, name, input } = convertToolCall(call);
        const tool = tools.find((candidate) => candidate.name === name);
        if (!tool) {
          appendFailure(ctx, messages, toolResults, {
            callId: id,
            name,
            stepId,
            error: `unknown tool: ${name}`,
          });
          continue;
        }

        const approval = await checkStageApproval(tool, input, ctx);
        if (!approval.ok) {
          appendFailure(ctx, messages, toolResults, {
            callId: id,
            name,
            stepId,
            error: approval.reason,
          });
          continue;
        }

        const callKey = `${name}:${safeStringify(input)}`;
        const repeatCount = (repeatMap.get(callKey) ?? 0) + 1;
        repeatMap.set(callKey, repeatCount);
        if (repeatCount > MAX_REPEAT) {
          appendFailure(ctx, messages, toolResults, {
            callId: id,
            name,
            stepId,
            error: `repeated identical call (${repeatCount}x) - refusing to re-execute; try different arguments or stop`,
          });
          continue;
        }

        let result: ToolResult;
        const toolStartedAt = Date.now();
        try {
          ctx.onToolEvent?.({ type: 'tool_start', callId: id, name: tool.name, stepId, input });
          result = await raceWithTimeout(
            tool.execute(input, ctx.toolContext),
            TOOL_TIMEOUT_MS,
            ctx.signal,
          );
        } catch (error) {
          result = {
            callId: id,
            ok: false,
            error: (error as Error).message,
            durationMs: Date.now() - toolStartedAt,
          };
        }
        result = {
          ...result,
          callId: id,
          durationMs: result.durationMs ?? Date.now() - toolStartedAt,
        };
        if (result.output !== undefined && typeof result.output !== 'undefined') {
          const sanitized = sanitizeOutput(result.output, sanitizeOpts);
          result.output = sanitized.output;
          result.sanitized = sanitized.sanitized || result.sanitized === true;
        }
        result = stampStepMeta(result, stepId);
        ctx.onToolEvent?.({
          type: 'tool_end',
          callId: id,
          name: tool.name,
          stepId,
          ok: result.ok,
          output: result.ok && result.output !== undefined ? String(result.output).slice(0, 400) : undefined,
          error: result.error,
          durationMs: result.durationMs,
        });
        toolResults.push(result);
        persistToolResult(ctx, result);
        messages.push({
          role: 'tool',
          tool_call_id: id,
          name,
          content: toolResultForModel(result),
        });
      }
      continue;
    }

    return {
      ok: false,
      content: '',
      toolResults,
      iterations: iteration,
      error: `llm finishReason: ${response.finishReason}`,
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

export function applyUsage(ctx: RunContext, usage: ChatResponse['usage'] | undefined): void {
  if (!usage) return;
  ctx.usage = {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens ?? usage.promptTokens + usage.completionTokens,
    source: 'provider',
  };
}

function appendFailure(
  ctx: RunContext,
  messages: ToolLoopOptions['messages'],
  results: ToolResult[],
  failure: { callId: string; name: string; stepId?: string; error?: string },
): void {
  const result = stampStepMeta({ callId: failure.callId, ok: false, error: failure.error }, failure.stepId);
  results.push(result);
  persistToolResult(ctx, result);
  messages.push({
    role: 'tool',
    tool_call_id: failure.callId,
    name: failure.name,
    content: toolResultForModel(result),
  });
  ctx.onToolEvent?.({
    type: 'tool_end',
    callId: failure.callId,
    name: failure.name,
    stepId: failure.stepId,
    ok: false,
    error: failure.error,
  });
}

function toolToSpec(tool: AgentTool): ToolSpec {
  const explicit = tool.inputSchema.jsonSchema;
  const parameters = explicit
    ? explicit as object
    : zodToJsonSchema(tool.inputSchema as unknown as z.ZodTypeAny);
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters },
  };
}

async function checkStageApproval(
  tool: AgentTool,
  input: unknown,
  ctx: RunContext,
): Promise<{ ok: boolean; reason?: string }> {
  if (!tool.requiresApproval) return { ok: true };
  const approve = ctx.toolContext.approve;
  if (!approve) return { ok: false, reason: 'approval unavailable' };
  try {
    return await approve(tool.name, input)
      ? { ok: true }
      : { ok: false, reason: 'denied by approval gate' };
  } catch (error) {
    return { ok: false, reason: `approval error: ${(error as Error).message}` };
  }
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (kind: 'resolve' | 'reject', value: T | unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (kind === 'resolve') resolve(value as T);
      else reject(value);
    };
    const onAbort = () => settle('reject', new Error('aborted'));
    timer = setTimeout(() => settle('reject', new Error(`tool timed out after ${timeoutMs}ms`)), timeoutMs);
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    promise.then(
      (value) => settle('resolve', value),
      (error) => settle('reject', error),
    );
  });
}

function stampStepMeta(result: ToolResult, stepId?: string): ToolResult {
  if (!stepId) return result;
  return { ...result, meta: { ...(result.meta ?? {}), stepId } };
}

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

function persistToolResult(ctx: RunContext, result: ToolResult): void {
  ctx.produced.push({
    id: randomUUID(),
    role: 'tool',
    content: [{ type: 'tool_result', result }],
    timestamp: new Date().toISOString(),
    sessionId: ctx.sessionId,
    runId: ctx.runId,
    stage: 'execute',
  });
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[non-serializable]';
  }
}

function toolResultForModel(result: ToolResult): string {
  return safeStringify({
    ok: result.ok,
    status: result.ok ? 'succeeded' : 'failed',
    durationMs: result.durationMs,
    stepId: typeof result.meta?.stepId === 'string' ? result.meta.stepId : undefined,
    output: result.ok ? result.output : undefined,
    error: result.ok ? undefined : result.error,
    sanitized: result.sanitized === true || undefined,
  });
}
