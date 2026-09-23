// Owns the bounded model loop and persisted messages; ToolExecutionService
// owns invocation validation, approval, execution, events, and evidence.
import {
  type ChatMessage,
  type ChatResponse,
  type ToolCall as LlmToolCall,
} from '@littlesheep/llm';
import type {
  RunContext,
  ToolInvocationRecord,
  ToolResult,
} from '@littlesheep/types';
import { sanitizeWebEvidenceProjection } from '@littlesheep/types';
import {
  durableToolResult,
  ToolExecutionService,
} from '@littlesheep/tools';
import { buildRunRequestCandidates } from '../../context-candidates.js';
import { modelRequestIdFor, prepareModelRequest } from '../../model-observability.js';
import { RunTailLedger, priorTailEntries, spliceTailMessages } from '../../run-tail-ledger.js';
import {
  abortTranscriptTurn,
  closeTranscriptTurn,
  createTranscriptTurn,
  runTranscriptModelTurn,
} from './model-transcript.js';
import { upsertToolInvocationEvidence } from '../../execution-evidence-state.js';
import { conversationHistoryForModel } from '../_shared.js';
import { toolToSpec } from '../../provider-tool-spec.js';
import {
  evaluateUserInputRequestRound,
  USER_INPUT_REQUEST_SIBLING_REFUSAL,
  USER_INPUT_REQUEST_TOOL_NAME,
} from '../../user-input-request.js';
import { ingestMemoryKnownState } from '../../memory-known-state.js';
import { ingestMemoryContextToolResult } from '../../memory-context-working-set.js';
import {
  failureResult,
  modelContentForResult,
  persistRuntimeControlMessage,
  persistRuntimeTailMessages,
  persistToolCalls,
  persistToolResult,
  persistVerifyGapControl,
  recordDurableToolCalls,
  RUNTIME_CONTROL_MESSAGES,
  sentToolOutputs,
} from './tool-result-persistence.js';
import { validateWebCitations, webCitationRepairContract } from '../../web-citation-validation.js';
import type {
  ExecuteStageDeps,
  ToolLoopOptions,
  ToolLoopResult,
} from './contracts.js';
import { createSideEffectLifecycle } from './side-effect-lifecycle.js';
import { toolRoundFailurePolicy } from './tool-failure-disposition.js';
import {
  decideSpentIterationBudget,
  MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS,
  MAX_TOOL_LOOP_ITERATIONS,
  reserveToolLoopIteration,
  toolLoopIterationCeiling,
} from './iteration-budget.js';
import {
  persistToolLoopProgress,
  registerEvidenceFingerprint,
} from './evidence-progress.js';

const MAX_ITERATIONS = MAX_TOOL_LOOP_ITERATIONS;
/**
 * How many tool calls the loop refuses after a final answer was forced. The first
 * refusal carries the instruction back; a model that keeps calling tools ends the
 * run as before.
 */
const MAX_FORCED_TOOL_REFUSALS = 2;
const MAX_WEB_CITATION_REPAIRS = 2;
const executionServices = new WeakMap<RunContext, ToolExecutionService>();

export function convertToolCall(tc: LlmToolCall): { id: string; name: string; input: unknown; rawArguments: string } {
  let input: unknown;
  try {
    input = JSON.parse(tc.function.arguments || '{}');
  } catch {
    input = {};
  }
  // The raw string travels with the call so a later run can replay the exact
  // assistant message the Provider produced; `persistToolCalls` keeps it only
  // when the tool declares no input projector.
  return { id: tc.id, name: tc.function.name, input, rawArguments: tc.function.arguments ?? '' };
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
    tailSegments = [],
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
  const control = RUNTIME_CONTROL_MESSAGES;
  const sentPayloads = sentToolOutputs(ctx);
  const executionService = toolExecutionService(deps, ctx, sanitizeOpts);
  const evidenceFingerprints = new Set<string>(ctx.loopBudget?.evidenceFingerprints ?? []);
  const fingerprintState = {
    saturated: ctx.loopBudget?.evidenceFingerprintSaturated === true,
  };
  // The history the request was assembled from: the task-interval replay when the
  // run has one. The candidate assembler needs the same source *and* the number of
  // chat messages it produced, because a replayed tool pair occupies more
  // messages than the prose projection has entries.
  const initialHistory = history ?? ctx.modelHistory ?? conversationHistoryForModel(ctx);
  const historyChatCount = opts.historyChatCount
    ?? (history ? history.length : initialHistory.length);
  // The runtime-owned tail is the run's append-only Runtime context.
  //
  // The initial tail (capability facts and the per-turn retrieval contract)
  // belongs directly after the current user turn, which is where the model
  // reads it; every later tool round is then appended *after* it. That is what
  // makes iteration N's exact request the prefix of iteration N+1's, the
  // condition the Provider's prefix cache matches. Appending the initial tail
  // at the very end instead put it after the first tool round and stopped the
  // second request from extending the first.
  const tailLedger = new RunTailLedger(priorTailEntries(ctx));
  const initialTail = tailLedger.update(ctx, systemSegments, tailSegments);
  const tailMessageSet = new Set<ChatMessage>();
  const initialTailMessages = initialTail.messages;
  for (const message of initialTailMessages) tailMessageSet.add(message);
  // The tail is part of the request the Provider caches, so it is persisted here:
  // a later run replays it, and unchanged sections are not re-emitted.
  persistRuntimeTailMessages(ctx, produced, initialTailMessages, initialTail.entries);
  // Each tail message's declared Context kind, so a bootstrap file stays project
  // knowledge and the memory index stays a memory index.
  const tailKinds = spliceTailMessages(messages, initialTail);
  let noProgressRounds = ctx.loopBudget?.noProgressRounds ?? 0;
  let forceFinalResponse = noProgressRounds >= MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS;
  let citationRepairAttempts = 0;
  let forcedRefusals = 0;
  /** Guards the single final-answer request allowed past the iteration budget. */
  let budgetFinalAnswerRequested = false;
  if (forceFinalResponse) {
    // A restored latch forces the answer too, so the model has to be told. The
    // instruction travels as a persisted Runtime control message (the request keeps
    // its tool catalog and `auto`); without it the model would keep calling tools
    // and only learn from the refusal.
    persistRuntimeControlMessage(ctx, produced, messages, control.noProgressBound);
  }
  // RECOVER re-enters this loop when VERIFY found a structural gap; the model was
  // not in that stage, so it has to be told what the run was sent back for.
  persistVerifyGapControl(ctx, produced, messages);

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    if (!reserveToolLoopIteration(ctx)) {
      // A spent budget ends the loop, not the turn: one bounded final-answer
      // request is allowed so the model can report the work it already did.
      // Measured on a real acceptance run, the game was written to disk and the
      // user still got a three-way "how should I proceed?" question because the
      // loop stopped mid-polish with no chance to say what it had delivered.
      // `decideSpentIterationBudget` owns the rule, including the case where
      // there is no work to report.
      const spent = decideSpentIterationBudget({
        toolResultCount: toolResults.length,
        finalAnswerAlreadyRequested: budgetFinalAnswerRequested,
        controlMessage: control.iterationBudgetExhausted,
        // The run's own ceiling, so the failure names the budget that actually
        // ran out — a restored checkpoint can carry a different one.
        maxIterations: toolLoopIterationCeiling(ctx),
      });
      if (spent.kind === 'fail') {
        return { ok: false, content: '', toolResults, iterations: iteration - 1, error: spent.error };
      }
      budgetFinalAnswerRequested = true;
      forceFinalResponse = true;
      persistRuntimeControlMessage(ctx, produced, messages, spent.controlMessage);
    }
    let response: ChatResponse;
    let request: import('@littlesheep/llm').ChatRequest;
    // Next path only: publish thinking plus per-turn prose as an ordered
    // transcript. The legacy path keeps its previous event sequence.
    const transcriptTurn = createTranscriptTurn(ctx, stepId, iteration);
    // Append this round's tail additions before the request is assembled. An
    // unchanged fact adds nothing here, so the messages already sent stay put.
    const tailDelta = tailLedger.update(ctx, systemSegments, tailSegments);
    for (const message of tailDelta.messages) tailMessageSet.add(message);
    messages.push(...tailDelta.messages);
    persistRuntimeTailMessages(ctx, produced, tailDelta.messages);
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
        // Forcing a final answer must not rewrite the tool list *or* the choice:
        // the tool schema sits inside the cacheable prefix, and the provider
        // renders the prompt without it when `tool_choice` is `none` — measured on
        // the frozen real-long-task runs, every forced request reported 1.8k-2.0k
        // fewer prompt tokens than its predecessor (exactly the catalog) and lost
        // the cached prefix. The instruction not to call a tool already travels as
        // a persisted Runtime control message, so the catalog and `auto` stay and a
        // call that ignores the instruction is refused below instead of executed.
        tools: hasTools ? toolSpecs : undefined,
        tool_choice: hasTools ? 'auto' : undefined,
        temperature: 0,
        signal,
      } satisfies import('@littlesheep/llm').ChatRequest;
      request = prepareModelRequest(
        ctx,
        'execute_tool_loop',
        rawRequest,
        buildRunRequestCandidates(ctx, 'execute', messages, {
          history: initialHistory,
          historyChatCount,
          systemSegments,
          insertedBeforePrimary,
          // The loop owns the runtime tail (the prompt sections marked
          // `placement: 'trailing'` and the appended Runtime facts), so this
          // assembler must not emit a second copy of them per request.
          trailingOwnership: 'caller',
          tailMessages: tailMessageSet,
          tailKinds,
        }),
        // The loop owns the append-only tail; the request recorder must not
        // re-inject (and thereby re-position) it per iteration. Context trimming
        // is likewise restricted to `appended-only`: every message this run has
        // already sent must survive, so an over-budget request fails visibly
        // instead of quietly dropping one from the middle and re-numbering the
        // rest.
        { skipRuntimeTail: true, evictionScope: 'appended-only' },
      );
      response = await runTranscriptModelTurn(ctx, deps.llm, request, transcriptTurn);
      if (process.env.LS_TAIL_DEBUG) {
        console.log('LOOP SENT', JSON.stringify({
          first: typeof request.messages[0]?.content === 'string' ? request.messages[0]!.content.length : -1,
          count: request.messages.length,
          canonicalFirst: typeof messages[0]?.content === 'string' ? messages[0]!.content.length : -1,
          canonicalCount: messages.length,
        }));
      }
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
        const citationRepair = `${webCitationRepairContract(ctx.webEvidence)}\n\nValidation failure: ${citationValidation.reason}`;
        // Persisted too: an unrecorded Runtime control message stopped the next
        // run's replay at the previous request's last message (A2: diff@19 of 20).
        persistRuntimeControlMessage(ctx, produced, messages, citationRepair);
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
        // The correction path builds its request on top of this exact one.
        requestMessages: [...messages],
        requestTools: request.tools,
        requestTailMessages: new Set(tailMessageSet),
      };
    }

    if (response.finishReason === 'tool_calls' && response.toolCalls.length > 0) {
      if (forceFinalResponse && forcedRefusals >= MAX_FORCED_TOOL_REFUSALS) {
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
      const round = evaluateUserInputRequestRound(response.toolCalls.map((call) => ({
        name: call.function.name,
        input: convertToolCall(call).input,
      })));
      if (round.kind === 'invalid') {
        return { ok: false, content: '', toolResults, iterations: iteration, error: round.error };
      }
      if (round.kind === 'mixed') {
        // The question is real, the calls beside it are not run: work that may
        // depend on the answer has to wait for it. They are refused with a
        // recorded reason instead of failing the turn, so the model's own wording
        // still reaches the user and the next run can see which calls never ran.
        // The question itself gets no tool result — the turn's outcome is the
        // question, exactly as when it is asked alone.
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
        const siblings = response.toolCalls.filter(
          (call) => call.function.name !== USER_INPUT_REQUEST_TOOL_NAME,
        );
        persistToolCalls(
          ctx,
          produced,
          response.toolCalls.map(convertToolCall),
          response.reasoningContent,
          response.content,
        );
        await recordDurableToolCalls(ctx, siblings.map(convertToolCall), stepId);
        for (const call of siblings) {
          const converted = convertToolCall(call);
          finalizeToolResult(
            ctx,
            produced,
            messages,
            toolResults,
            converted.name,
            failureResult(converted.id, stepId, USER_INPUT_REQUEST_SIBLING_REFUSAL),
            sentPayloads,
          );
        }
        return {
          ok: true,
          content: '',
          toolResults,
          iterations: iteration,
          usage: response.usage,
          userInputRequest: round.request,
          modelRequestId: modelRequestIdFor(request),
        };
      }
      if (round.kind === 'request') {
        return {
          ok: true,
          content: '',
          toolResults,
          iterations: iteration,
          usage: response.usage,
          userInputRequest: round.request,
          // The question the model asked is user-facing text, so it carries the
          // request that authored it. Without this the caller would have to ask
          // the model to word the same question again just to prove it.
          modelRequestId: modelRequestIdFor(request),
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
      persistToolCalls(
        ctx,
        produced,
        response.toolCalls.map(convertToolCall),
        response.reasoningContent,
        response.content,
      );
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
      // While a final answer is forced, every call is withheld: the model was told
      // tools are unavailable in this run, so a call is refused with an
      // authoritative denial rather than executed. Refusing keeps the run alive
      // (and its catalog in the cached prefix) where failing it outright used to.
      if (forceFinalResponse) forcedRefusals += 1;
      const withheld = forceFinalResponse
        ? requests
        : requests.filter((request) => registeredNames.has(request.name) && !admittedNames.has(request.name));
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
          forceFinalResponse
            ? 'Runtime control: tools are unavailable in this run; answer from the evidence already present.'
            : withheldToolContract
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
        finalizeToolResult(ctx, produced, messages, toolResults, converted.name, result, sentPayloads);
      }

      // Only an authoritative boundary (a refusal, an unprovable outcome) closes
      // the run's ability to act; a determinate execution failure stays in this
      // loop for the model to correct, under the same budgets as any other round.
      const failurePolicy = toolRoundFailurePolicy(ctx, [...executedResults.values()], control);
      if (failurePolicy.forceFinalResponse) forceFinalResponse = true;
      if (failurePolicy.controlMessage) {
        persistRuntimeControlMessage(ctx, produced, messages, failurePolicy.controlMessage);
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
        // P4a: state the observation and hand the choice back instead of issuing an
        // order. The bound itself is unchanged — tools stop being available in this
        // run, and saying so keeps the instruction honest.
        persistRuntimeControlMessage(ctx, produced, messages, control.noProgressBound);
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

function finalizeToolResult(
  ctx: RunContext,
  produced: RunContext['produced'],
  messages: ToolLoopOptions['messages'] | undefined,
  results: ToolResult[],
  name: string,
  result: ToolResult,
  sentPayloads: Map<string, string>,
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
  // A payload the conversation already carries is referenced, not repeated: the
  // earlier copy is still in the request and in the cached prefix, so sending it
  // again only adds new input (measured: 7% of all tool-result characters).
  const modelContent = modelContentForResult(result, sentPayloads);
  persistToolResult(ctx, produced, durable, modelContent);
  messages?.push({
      role: 'tool',
      tool_call_id: result.callId,
      name,
      content: modelContent,
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

