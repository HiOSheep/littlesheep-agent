// Owns the bounded model loop and persisted messages; ToolExecutionService
// owns invocation validation, approval, execution, events, and evidence.
import { createHash, randomUUID } from 'node:crypto';
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
  ToolInvocationRecord,
  ToolResult,
} from '@littlesheep/types';
import { sanitizeWebEvidenceProjection } from '@littlesheep/types';
import {
  durableToolResult,
  projectToolInput,
  ToolExecutionService,
  type ToolExecutionLifecycle,
} from '@littlesheep/tools';
import { buildRunRequestCandidates } from '../../context-candidates.js';
import { prepareModelRequest, callModelChat } from '../../model-observability.js';
import { writeProviderUsageState } from '../../usage-state.js';
import { upsertToolInvocationEvidence } from '../../execution-evidence-state.js';
import { recentHistoryForModel } from '../_shared.js';
import { ingestMemoryKnownState } from '../../memory-known-state.js';
import { ingestMemoryContextToolResult } from '../../memory-context-working-set.js';
import { validateWebCitations, webCitationRepairContract } from '../../web-citation-validation.js';
import type {
  ExecuteSanitizeOptions,
  ExecuteStageDeps,
  ToolLoopOptions,
  ToolLoopResult,
} from './contracts.js';
import {
  beginSideEffect,
  describeSideEffect,
  finishSideEffect,
  sideEffectCheckpointReason,
} from './side-effect-ledger.js';

const MAX_ITERATIONS = 20;
const MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS = 2;
const MAX_EVIDENCE_FINGERPRINTS = MAX_ITERATIONS * 8;
const MAX_CONTINUATION_HISTORY_MESSAGES = 2;
const MAX_WEB_CITATION_REPAIRS = 2;
const executionServices = new WeakMap<RunContext, ToolExecutionService>();

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
  const {
    ctx,
    messages,
    tools,
    sanitizeOpts,
    stepId,
    systemSegments,
    insertedBeforePrimary,
    history,
    signal = ctx.signal,
    produced = ctx.produced,
    parallelStep,
    maxParallelTools,
  } = opts;
  const toolSpecs = tools.map(toolToSpec);
  const toolResults: ToolResult[] = [];
  const executionService = toolExecutionService(deps, ctx, sanitizeOpts);
  const evidenceFingerprints = new Set<string>();
  const initialHistory = history ?? recentHistoryForModel(ctx.history, 8);
  let requestHistory = initialHistory;
  let continuationCompacted = false;
  let noProgressRounds = 0;
  let forceFinalResponse = false;
  let citationRepairAttempts = 0;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    let response: ChatResponse;
    try {
      const rawRequest = {
        model: deps.model,
        messages,
        tools: !forceFinalResponse && toolSpecs.length > 0 ? toolSpecs : undefined,
        tool_choice: !forceFinalResponse && toolSpecs.length > 0 ? 'auto' : undefined,
        temperature: 0,
        signal,
      } satisfies import('@littlesheep/llm').ChatRequest;
      const request = prepareModelRequest(
        ctx,
        'execute_tool_loop',
        rawRequest,
        buildRunRequestCandidates(ctx, 'execute', rawRequest.messages, {
          history: requestHistory,
          systemSegments,
          insertedBeforePrimary,
        }),
      );
      response = await callModelChat(ctx, deps.llm, request);
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
      const citationValidation = validateWebCitations(response.content, ctx.webEvidence);
      if (!citationValidation.ok && ctx.webEvidence && citationRepairAttempts < MAX_WEB_CITATION_REPAIRS) {
        citationRepairAttempts += 1;
        messages.push({
          role: 'assistant',
          content: response.content,
        });
        messages.push({
          role: 'system',
          content: `${webCitationRepairContract(ctx.webEvidence)}\n\nValidation failure: ${citationValidation.reason}`,
        });
        forceFinalResponse = true;
        continue;
      }
      if (!citationValidation.ok && ctx.webEvidence) {
        return {
          ok: false,
          content: '',
          toolResults,
          iterations: iteration,
          error: `web citation validation failed after ${MAX_WEB_CITATION_REPAIRS} repair attempts: ${citationValidation.reason}`,
        };
      }
      return {
        ok: true,
        content: response.content,
        toolResults,
        iterations: iteration,
        usage: response.usage,
      };
    }

    if (response.finishReason === 'tool_calls' && response.toolCalls.length > 0) {
      if (forceFinalResponse) {
        return {
          ok: false,
          content: '',
          toolResults,
          iterations: iteration,
          error: 'llm requested more tools after the runtime no-progress budget was exhausted',
        };
      }
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
      persistToolCalls(ctx, produced, response.toolCalls.map(convertToolCall));
      await recordDurableToolCalls(ctx, response.toolCalls.map(convertToolCall), stepId);

      const requests = response.toolCalls.map((call) => {
        const converted = convertToolCall(call);
        return {
          callId: converted.id,
          name: converted.name,
          input: converted.input,
          stepId,
          signal,
          parallelStep,
        };
      });
      const executedResults = await executionService.executeBatch(
        requests,
        sideEffectLifecycle(ctx),
        new Set(tools.map((tool) => tool.name)),
        maxParallelTools,
      );
      let addedEvidence = false;
      for (const [index, call] of response.toolCalls.entries()) {
        const converted = convertToolCall(call);
        const result = executedResults.get(index)
          ?? failureResult(converted.id, stepId, 'tool scheduler returned no result');
        if (registerEvidenceFingerprint(ctx, evidenceFingerprints, converted.name, result)) {
          addedEvidence = true;
        }
        finalizeToolResult(ctx, produced, messages, toolResults, converted.name, result);
      }

      // A failed Runtime/tool boundary is authoritative for this step. Allow
      // one final text response with tools disabled, but do not let the model
      // probe around an unknown tool, denied permission, invalid input or
      // blocked side effect inside the same step.
      if (executedResults.size > 0
        && [...executedResults.values()].some((result) => !result.ok)) {
        forceFinalResponse = true;
        messages.push({
          role: 'system',
          content: 'Runtime control: the latest tool boundary failed. Do not call another tool in this step. Return a concise step result that preserves the failure and uncertainty for VERIFY/RECOVER.',
        });
      }

      // Tool results are now authoritative for the active step. Keep the
      // current user message, system contract, latest turn, and the required
      // attachment manifest, but drop older history from later rounds. This
      // reduces repeated prompt cost without hiding the evidence or attachment
      // lookup entry points the model needs to decide whether another tool is
      // necessary.
      if (!continuationCompacted) {
        const keptHistoryCount = Math.min(MAX_CONTINUATION_HISTORY_MESSAGES, initialHistory.length);
        if (compactToolLoopContinuation(
          messages,
          initialHistory.length,
          insertedBeforePrimary?.length ?? 0,
          keptHistoryCount,
        )) {
          requestHistory = initialHistory.slice(-keptHistoryCount);
          continuationCompacted = true;
        }
      }
      noProgressRounds = addedEvidence ? 0 : noProgressRounds + 1;
      if (noProgressRounds >= MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS) {
        forceFinalResponse = true;
        messages.push({
          role: 'system',
          content: 'Runtime control: recent tool calls produced no new evidence. Stop calling tools and answer from the evidence already present. State any remaining uncertainty instead of probing again.',
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

/** Execute one Runtime-admitted DECIDE proposal through the same hosted tool boundary. */
export async function runDirectToolProposal(
  deps: ExecuteStageDeps,
  options: {
    ctx: RunContext;
    tool: AgentTool;
    input: unknown;
    sanitizeOpts: ExecuteSanitizeOptions;
    stepId: string;
    signal?: AbortSignal;
    produced?: RunContext['produced'];
  },
): Promise<ToolLoopResult> {
  const produced = options.produced ?? options.ctx.produced;
  const call: ToolCall = {
    id: randomUUID(),
    name: options.tool.name,
    input: options.input,
  };
  persistToolCalls(options.ctx, produced, [call]);
  await recordDurableToolCalls(options.ctx, [call], options.stepId);
  const service = toolExecutionService(deps, options.ctx, options.sanitizeOpts);
  const completed = await service.executeBatch(
    [{
      callId: call.id,
      name: call.name,
      input: call.input,
      stepId: options.stepId,
      signal: options.signal ?? options.ctx.signal,
    }],
    sideEffectLifecycle(options.ctx),
    new Set([options.tool.name]),
    1,
  );
  const result = completed.get(0)
    ?? failureResult(call.id, options.stepId, 'tool scheduler returned no result');
  const toolResults: ToolResult[] = [];
  finalizeToolResult(
    options.ctx,
    produced,
    undefined,
    toolResults,
    options.tool.name,
    result,
  );
  return {
    ok: true,
    content: '',
    toolResults,
    iterations: 0,
  };
}

/** Keep the current request and tool evidence while dropping older pre-user history. */
function compactToolLoopContinuation(
  messages: import('@littlesheep/llm').ChatMessage[],
  historyCount: number,
  insertedCount: number,
  keptHistoryCount: number,
): boolean {
  const primaryUserIndex = 1 + historyCount + insertedCount;
  if (messages[0]?.role !== 'system' || messages[primaryUserIndex]?.role !== 'user') return false;
  const removeCount = historyCount - keptHistoryCount;
  if (removeCount <= 0) return false;
  messages.splice(1, removeCount);
  return true;
}

function registerEvidenceFingerprint(
  ctx: RunContext,
  fingerprints: Set<string>,
  toolName: string,
  result: ToolResult,
): boolean {
  const sideEffect = result.ok
    ? ctx.sideEffects?.find((effect) => effect.callId === result.callId && effect.status === 'succeeded')
    : undefined;
  const fingerprint = createHash('sha256')
    .update(toolName)
    .update('\0')
    .update(sideEffect ? 'side-effect' : result.ok ? 'ok' : 'error')
    .update('\0')
    .update(sideEffect?.idempotencyKey ?? safeStringify(result.ok ? result.output : result.error))
    .digest('hex');
  if (fingerprints.has(fingerprint)) return false;
  if (fingerprints.size < MAX_EVIDENCE_FINGERPRINTS) fingerprints.add(fingerprint);
  return true;
}

export function applyUsage(
  ctx: RunContext,
  usage: ChatResponse['usage'] | undefined,
  stage: 'execute',
): void {
  writeProviderUsageState(ctx, stage, usage);
}

function failureResult(callId: string, stepId: string | undefined, error?: string): ToolResult {
  return stampStepMeta({ callId, ok: false, error }, stepId);
}

function finalizeToolResult(
  ctx: RunContext,
  produced: RunContext['produced'],
  messages: ToolLoopOptions['messages'] | undefined,
  results: ToolResult[],
  name: string,
  result: ToolResult,
): void {
  if (name === 'memory_tree' || name === 'memory_search' || name === 'memory_deep_search') {
    ingestMemoryKnownState(ctx, result.meta?.memoryKnownState, 'execute');
    ingestMemoryContextToolResult(ctx, result.callId, result, 'execute');
  }
  if (result.webEvidence) {
    ctx.webEvidence = sanitizeWebEvidenceProjection(result.webEvidence);
  }
  const durable = durableToolResult(result);
  results.push(durable);
  persistToolResult(ctx, produced, durable);
  messages?.push({
      role: 'tool',
      tool_call_id: result.callId,
      name,
      content: toolResultForModel(result),
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

function toolExecutionService(
  deps: ExecuteStageDeps,
  ctx: RunContext,
  sanitizeOpts: ToolLoopOptions['sanitizeOpts'],
): ToolExecutionService {
  const existing = executionServices.get(ctx);
  if (existing) return existing;
  const service = new ToolExecutionService({
    registrations: ctx.tools.map((tool) => ({
      tool,
      source: ctx.toolSources?.[tool.name] ?? 'unknown',
    })),
    toolContext: ctx.toolContext,
    maxParallel: deps.config.tools.maxParallel,
    timeoutMs: deps.config.tools.invocationTimeoutMs,
    sanitize: sanitizeOpts,
    onToolEvent: (event) => ctx.onToolEvent?.(event),
    onRecord: (record, state) => updateInvocationRecord(ctx, record, state),
  });
  executionServices.set(ctx, service);
  return service;
}

function updateInvocationRecord(
  ctx: RunContext,
  record: ToolInvocationRecord,
  state: { retained: boolean; truncated: boolean },
): void {
  upsertToolInvocationEvidence(ctx, 'execute', record, state);
}

function stampStepMeta(result: ToolResult, stepId?: string): ToolResult {
  if (!stepId) return result;
  return { ...result, meta: { ...(result.meta ?? {}), stepId } };
}

function sideEffectLifecycle(ctx: RunContext): ToolExecutionLifecycle {
  const effects = new Map<string, ReturnType<typeof describeSideEffect>>();
  return {
    async beforeInvoke(invocation) {
      const sideEffect = describeSideEffect(
        invocation.tool,
        invocation.input,
        invocation.resources,
        invocation.request.stepId,
        invocation.request.callId,
      );
      effects.set(invocation.request.callId, sideEffect);
      if (!sideEffect) return;
      let begin: Awaited<ReturnType<typeof beginSideEffect>>;
      try {
        // The intent must be durable before Tool Execution Service is allowed
        // to invoke a write-capable or external tool.
        begin = await beginSideEffect(ctx, sideEffect);
      } catch (error) {
        return {
          result: {
            callId: invocation.request.callId,
            ok: false,
            error: `refusing effectful tool until its intent is durable: ${(error as Error).message}`,
          },
          status: 'failed',
          errorKind: 'effect_intent_persistence',
        };
      }
      if (begin.kind === 'duplicate' || begin.kind === 'blocked') {
        return {
          result: {
            callId: invocation.request.callId,
            ok: false,
            error: begin.kind === 'duplicate'
              ? `side effect already recorded as succeeded; refusing to replay ${sideEffect.idempotencyKey}`
              : begin.reason,
          },
          status: begin.kind === 'duplicate' ? 'repeated_call_blocked' : 'failed',
          errorKind: begin.kind === 'duplicate' ? 'side_effect_replay' : 'side_effect_blocked',
        };
      }
      try {
        await ctx.persistRuntimeCheckpoint?.(sideEffectCheckpointReason(sideEffect, 'started'));
      } catch (error) {
        await finishSideEffect(ctx, sideEffect, {
          callId: invocation.request.callId,
          ok: false,
          error: `checkpoint before side effect failed: ${(error as Error).message}`,
        });
        return {
          result: {
            callId: invocation.request.callId,
            ok: false,
            error: `refusing effectful tool until its checkpoint is durable: ${(error as Error).message}`,
          },
          status: 'failed',
          errorKind: 'checkpoint_before_effect',
        };
      }
    },
    async afterInvoke(invocation, result) {
      const sideEffect = effects.get(invocation.request.callId);
      if (!sideEffect) return result;
      try {
        // The Tool Execution Service has returned an authoritative outcome.
        // Settle that outcome before writing the resumability projection so a
        // checkpoint failure cannot make a completed effect replayable.
        await finishSideEffect(ctx, sideEffect, result);
      } catch (error) {
        return {
          result: {
            ...result,
            ok: false,
            error: `side effect result is not durably settled: ${(error as Error).message}`,
          },
          status: 'failed',
          errorKind: 'effect_settlement_persistence',
        };
      }
      try {
        await ctx.persistRuntimeCheckpoint?.(sideEffectCheckpointReason(sideEffect, 'finished'));
        return result;
      } catch (error) {
        // The effect settlement is already durable. Surface the checkpoint
        // failure to the current step without downgrading the effect to
        // unknown or attempting a compensating settlement.
        return {
          result: {
            ...result,
            ok: false,
            error: `effect completed but checkpoint persistence failed: ${(error as Error).message}`,
            meta: {
              ...(result.meta ?? {}),
              effectSettlement: 'durable',
              checkpointPersistence: 'failed',
            },
          },
          status: 'failed',
          errorKind: 'checkpoint_after_effect',
        };
      }
    },
  };
}

function persistToolCalls(ctx: RunContext, produced: RunContext['produced'], calls: ToolCall[]): void {
  const durableCalls = calls.map((call) => {
    const tool = ctx.tools.find((candidate) => candidate.name === call.name);
    return {
      ...call,
      input: tool ? projectToolInput(tool, call.input) : { redacted: true, unknownTool: true },
    };
  });
  produced.push({
    id: randomUUID(),
    role: 'assistant',
    content: [{ type: 'tool_calls', calls: durableCalls }],
    timestamp: new Date().toISOString(),
    sessionId: ctx.sessionId,
    runId: ctx.runId,
    stage: 'execute',
  });
}

async function recordDurableToolCalls(
  ctx: RunContext,
  calls: readonly ToolCall[],
  stepId?: string,
): Promise<void> {
  for (const call of calls) {
    const inputHash = createHash('sha256').update(safeStringify(call.input), 'utf8').digest('hex');
    await ctx.appendDurableEvent?.({
      type: 'tool_call_proposed',
      source: 'model',
      eventId: `${ctx.runId}:tool-call:${call.id}`,
      idempotencyKey: `${ctx.runId}:tool-call:${call.id}`,
      payload: {
        callId: call.id,
        toolName: call.name,
        inputHash,
        ...(stepId ? { stepId } : {}),
      },
    });
  }
}

function persistToolResult(ctx: RunContext, produced: RunContext['produced'], result: ToolResult): void {
  produced.push({
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
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
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
    output: result.ok ? (result.modelOutput ?? result.output) : undefined,
    error: result.ok ? undefined : result.error,
    sanitized: result.sanitized === true || undefined,
  });
}
