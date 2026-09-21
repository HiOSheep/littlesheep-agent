// Owns the bounded model loop and persisted messages; ToolExecutionService
// owns invocation validation, approval, execution, events, and evidence.
import { createHash, randomUUID } from 'node:crypto';
import {
  type ChatMessage,
  type ChatResponse,
  type ToolCall as LlmToolCall,
} from '@littlesheep/llm';
import type {
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
} from '@littlesheep/tools';
import { buildRunRequestCandidates } from '../../context-candidates.js';
import { modelRequestIdFor, prepareModelRequest } from '../../model-observability.js';
import { RunTailLedger } from '../../run-tail-ledger.js';
import {
  abortTranscriptTurn,
  closeTranscriptTurn,
  createTranscriptTurn,
  runTranscriptModelTurn,
} from './model-transcript.js';
import { upsertToolInvocationEvidence } from '../../execution-evidence-state.js';
import { writeRuntimeState } from '../../runtime-state.js';
import { conversationHistoryForModel } from '../_shared.js';
import { toolToSpec } from '../../provider-tool-spec.js';
import { parseUserInputRequest, USER_INPUT_REQUEST_TOOL_NAME } from '../../user-input-request.js';
import { ingestMemoryKnownState } from '../../memory-known-state.js';
import { ingestMemoryContextToolResult } from '../../memory-context-working-set.js';
import { validateWebCitations, webCitationRepairContract } from '../../web-citation-validation.js';
import type {
  ExecuteStageDeps,
  ToolLoopOptions,
  ToolLoopResult,
} from './contracts.js';
import { createSideEffectLifecycle } from './side-effect-lifecycle.js';

const MAX_ITERATIONS = 20;
const MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS = 2;
const MAX_EVIDENCE_FINGERPRINTS = 128;
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
    admittedTools = tools,
    withheldToolContract,
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
  // The catalog is what the model sees; the admitted set is what this request
  // may execute. They differ when the Runtime withholds a registered capability
  // for this turn (a local-only retrieval intent, for example) — the model still
  // sees one stable catalog, and the boundary refuses the call.
  const admittedNames = new Set(admittedTools.map((tool) => tool.name));
  const toolSpecs = tools.map(toolToSpec);
  const toolResults: ToolResult[] = [];
  const executionService = toolExecutionService(deps, ctx, sanitizeOpts);
  const evidenceFingerprints = new Set<string>(ctx.loopBudget?.evidenceFingerprints ?? []);
  const fingerprintState = {
    saturated: ctx.loopBudget?.evidenceFingerprintSaturated === true,
  };
  const initialHistory = history ?? conversationHistoryForModel(ctx);
  // The runtime-owned tail is the run's append-only Runtime context.
  //
  // The initial tail (capability facts and the per-turn retrieval contract)
  // belongs directly after the current user turn, which is where the model
  // reads it; every later tool round is then appended *after* it. That is what
  // makes iteration N's exact request the prefix of iteration N+1's, the
  // condition the Provider's prefix cache matches. Appending the initial tail
  // at the very end instead put it after the first tool round and stopped the
  // second request from extending the first.
  const tailLedger = new RunTailLedger();
  const initialTail = tailLedger.update(ctx, systemSegments);
  const tailMessageSet = new Set<ChatMessage>();
  const initialTailMessages = initialTail.messages;
  for (const message of initialTailMessages) tailMessageSet.add(message);
  let primaryUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      primaryUserIndex = index;
      break;
    }
  }
  messages.splice(
    primaryUserIndex < 0 ? messages.length : primaryUserIndex + 1,
    0,
    ...initialTailMessages,
  );
  let noProgressRounds = ctx.loopBudget?.noProgressRounds ?? 0;
  let forceFinalResponse = noProgressRounds >= MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS;
  let citationRepairAttempts = 0;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    if (!reserveToolLoopIteration(ctx)) {
      return {
        ok: false,
        content: '',
        toolResults,
        iterations: iteration - 1,
        error: `tool loop exceeded the persisted ${MAX_ITERATIONS}-iteration run budget`,
      };
    }
    let response: ChatResponse;
    let request: import('@littlesheep/llm').ChatRequest;
    // Next path only: publish thinking plus per-turn prose as an ordered
    // transcript. The legacy path keeps its previous event sequence.
    const transcriptTurn = createTranscriptTurn(ctx, stepId, iteration);
    // Append this round's tail additions before the request is assembled. An
    // unchanged fact adds nothing here, so the messages already sent stay put.
    const tailDelta = tailLedger.update(ctx, systemSegments);
    for (const message of tailDelta.messages) tailMessageSet.add(message);
    messages.push(...tailDelta.messages);
    try {
      const hasTools = toolSpecs.length > 0;
      const rawRequest = {
        model: deps.model,
        messages,
        // Forcing a final answer must not rewrite the tool list. The tool schema
        // sits inside the cacheable prefix, so previously dropping it here made
        // the forced turn's prefix differ from every other turn in the run and
        // forfeited the cached prefix for that request. `tool_choice: 'none'`
        // forbids the call just as effectively while keeping the prefix intact.
        tools: hasTools ? toolSpecs : undefined,
        tool_choice: hasTools ? (forceFinalResponse ? 'none' : 'auto') : undefined,
        temperature: 0,
        signal,
      } satisfies import('@littlesheep/llm').ChatRequest;
      request = prepareModelRequest(
        ctx,
        'execute_tool_loop',
        rawRequest,
        buildRunRequestCandidates(ctx, 'execute', messages, {
          history: initialHistory,
          systemSegments,
          insertedBeforePrimary,
          // The loop owns the runtime tail (the prompt sections marked
          // `placement: 'trailing'` and the appended Runtime facts), so this
          // assembler must not emit a second copy of them per request.
          trailingOwnership: 'caller',
          tailMessages: tailMessageSet,
        }),
        // The loop owns the append-only tail; the request recorder must not
        // re-inject (and thereby re-position) it per iteration.
        { skipRuntimeTail: true },
      );
      response = await runTranscriptModelTurn(ctx, deps.llm, request, transcriptTurn);
    } catch (error) {
      abortTranscriptTurn(ctx, transcriptTurn, signal?.aborted ? 'aborted' : 'failed');
      return {
        ok: false,
        content: '',
        toolResults,
        iterations: iteration,
        error: `llm call failed: ${(error as Error).message}`,
      };
    }

    closeTranscriptTurn(ctx, transcriptTurn, response.finishReason);

    if (response.finishReason === 'stop') {
      const citationValidation = validateWebCitations(response.content, ctx.webEvidence);
      if (!citationValidation.ok && ctx.webEvidence && citationRepairAttempts < MAX_WEB_CITATION_REPAIRS) {
        ctx.onAssistantReplace?.('');
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
        ctx.onAssistantReplace?.('');
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
        modelRequestId: modelRequestIdFor(request),
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
      // Asking the user is the model's own decision: carry the bounded question
      // out of the loop, and let the caller publish it and record the single
      // waiting fact. Nothing is executed here, so a malformed request is a
      // protocol error rather than a tool failure.
      const inputRequests = response.toolCalls.filter(
        (call) => call.function.name === USER_INPUT_REQUEST_TOOL_NAME,
      );
      if (inputRequests.length > 0) {
        if (inputRequests.length !== 1 || response.toolCalls.length !== 1) {
          return {
            ok: false,
            content: '',
            toolResults,
            iterations: iteration,
            error: 'a user input request must be one standalone tool call',
          };
        }
        const userInputRequest = parseUserInputRequest(convertToolCall(inputRequests[0]!).input);
        if (!userInputRequest) {
          return {
            ok: false,
            content: '',
            toolResults,
            iterations: iteration,
            error: 'user input request failed Runtime schema validation',
          };
        }
        return {
          ok: true,
          content: '',
          toolResults,
          iterations: iteration,
          usage: response.usage,
          userInputRequest,
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
      // Only a tool the Runtime knows but withheld is refused here. A name that
      // is not registered at all still goes to the execution boundary, which
      // reports it as an unknown tool — the two failures are different facts and
      // the model must not read one as the other.
      const registeredNames = new Set(tools.map((tool) => tool.name));
      const withheld = requests.filter((request) => (
        registeredNames.has(request.name) && !admittedNames.has(request.name)
      ));
      const executable = requests.filter((request) => !withheld.includes(request));
      const executedResults = new Map(await executionService.executeBatch(
        executable,
        createSideEffectLifecycle(ctx),
        // The boundary re-checks the admitted set, so the model cannot reach a
        // withheld capability by naming it.
        admittedNames,
        maxParallelTools,
      ));
      // A withheld call is refused before it reaches the tool: nothing runs, no
      // side effect is attempted, and the model gets an authoritative denial it
      // must not retry.
      for (const request of withheld) {
        const index = requests.indexOf(request);
        executedResults.set(index, failureResult(
          request.callId,
          stepId,
          withheldToolContract
            ? `Runtime scope: ${withheldToolContract}`
            : 'Runtime scope: this tool is not admitted for the current request.',
        ));
      }
      let addedEvidence = false;
      for (const [index, call] of response.toolCalls.entries()) {
        const converted = convertToolCall(call);
        const result = executedResults.get(index)
          ?? failureResult(converted.id, stepId, 'tool scheduler returned no result');
        if (registerEvidenceFingerprint(ctx, evidenceFingerprints, fingerprintState, converted.name, result)) {
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

      // Tool results are now authoritative for the active step. Every later
      // round of this step keeps the exact messages already sent and appends to
      // them: a Provider prefix cache only matches from token 0, so dropping
      // older history here diverges the request at its second message and
      // forfeits the whole cached prefix for the rest of the step. History is
      // already bounded by the shared window, so append-only adds little.
      noProgressRounds = addedEvidence ? 0 : noProgressRounds + 1;
      persistToolLoopProgress(ctx, evidenceFingerprints, fingerprintState.saturated, noProgressRounds);
      if (noProgressRounds >= MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS) {
        forceFinalResponse = true;
        messages.push({
          role: 'system',
          // P4a: state the observation and hand the choice back instead of
          // issuing an order. The bound itself is unchanged — tools stop being
          // available in this run, and saying so keeps the instruction honest.
          content: 'Runtime control: the last rounds added no new evidence (same tool sources and targets). You can answer from the evidence already present, or say plainly what is still missing; tools are no longer available in this run.',
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

function registerEvidenceFingerprint(
  ctx: RunContext,
  fingerprints: Set<string>,
  state: { saturated: boolean },
  toolName: string,
  result: ToolResult,
): boolean {
  const invocation = [...(ctx.toolInvocations ?? [])]
    .reverse()
    .find((candidate) => candidate.callId === result.callId);
  const sideEffect = result.ok
    ? ctx.sideEffects?.find((effect) => effect.callId === result.callId && effect.status === 'succeeded')
    : undefined;
  const normalizedOutput = normalizeEvidenceOutput(safeStringify(result.ok ? result.output : result.error));
  const fingerprint = createHash('sha256')
    .update(toolName)
    .update('\0')
    .update(invocation?.toolSource ?? 'unknown-source')
    .update('\0')
    .update(invocation?.resourceKeys?.length
      ? invocation.resourceKeys.join('\0')
      : invocation?.inputHash ?? 'unknown-input')
    .update('\0')
    .update(invocation?.outputTruncated === true || result.sanitized === true ? 'partial' : 'complete')
    .update('\0')
    .update(sideEffect ? 'side-effect' : result.ok ? 'ok' : 'error')
    .update('\0')
    .update(sideEffect?.idempotencyKey ?? normalizedOutput)
    .digest('hex');
  if (fingerprints.has(fingerprint)) return false;
  if (state.saturated || fingerprints.size >= MAX_EVIDENCE_FINGERPRINTS) {
    state.saturated = true;
    return false;
  }
  fingerprints.add(fingerprint);
  return true;
}

function reserveToolLoopIteration(ctx: RunContext): boolean {
  const current = ctx.loopBudget?.toolLoopIterationsUsed ?? 0;
  const maximum = ctx.loopBudget?.maxToolLoopIterations ?? MAX_ITERATIONS;
  if (current >= maximum) return false;
  writeRuntimeState(ctx, 'execute', {
    loopBudget: {
      ...(ctx.loopBudget ?? {
        attemptsUsed: ctx.modelCallCount ?? 0,
        maxAttempts: ctx.maxModelCalls ?? 0,
        elapsedMs: 0,
        maxElapsedMs: 0,
        noProgressRounds: 0,
        maxNoProgressRounds: MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS,
      }),
      toolLoopIterationsUsed: current + 1,
      maxToolLoopIterations: maximum,
    },
  });
  return true;
}

function persistToolLoopProgress(
  ctx: RunContext,
  fingerprints: ReadonlySet<string>,
  saturated: boolean,
  noProgressRounds: number,
): void {
  writeRuntimeState(ctx, 'execute', {
    loopBudget: {
      ...(ctx.loopBudget ?? {
        attemptsUsed: ctx.modelCallCount ?? 0,
        maxAttempts: ctx.maxModelCalls ?? 0,
        elapsedMs: 0,
        maxElapsedMs: 0,
        noProgressRounds: 0,
        maxNoProgressRounds: MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS,
      }),
      noProgressRounds,
      maxNoProgressRounds: MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS,
      evidenceFingerprints: [...fingerprints],
      evidenceFingerprintSaturated: saturated,
    },
  });
}

function normalizeEvidenceOutput(value: string): string {
  return value
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][0-9:.+-]+Z?\b/gu, '<timestamp>')
    .replace(/\b(duration|elapsed|time)\s*[:=]\s*\d+(?:\.\d+)?\s*(?:ms|s)?\b/giu, '$1=<duration>')
    .replace(/\s+/gu, ' ')
    .trim();
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
