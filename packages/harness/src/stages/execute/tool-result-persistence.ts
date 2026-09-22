// Persist and project one tool round: what the model proposed, what came back,
// and the single bounded form each of them takes in the transcript and in the
// durable event log.
//
// The loop owns *when* a round is recorded; this module owns *what a record looks
// like*. Tool inputs are projected through the tool's own projector so a secret
// never reaches the transcript, and a result is reduced to the fields the next
// model turn actually needs.
import { createHash, randomUUID } from 'node:crypto';
import type { RunContext, ToolCall, ToolResult } from '@littlesheep/types';
import { projectToolInput } from '@littlesheep/tools';

/** Serialize a value for evidence without ever throwing on a hostile value. */
export function safeStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return '[non-serializable]';
  }
}

/** The bounded result shape the model sees for one tool call. */
export function toolResultForModel(result: ToolResult): string {
  const output = result.modelOutput ?? result.output;
  return safeStringify({
    ok: result.ok,
    status: result.ok ? 'succeeded' : 'failed',
    durationMs: result.durationMs,
    stepId: typeof result.meta?.stepId === 'string' ? result.meta.stepId : undefined,
    // A failed call keeps its output too. For a command runner the exit code alone
    // says nothing about what failed: dropping the captured stdout/stderr left the
    // model unable to diagnose a failing test, while the runtime still recorded the
    // output as evidence. The result is already bounded by the tool and sanitizer.
    output: typeof output === 'string' && output.length > 0 ? output : undefined,
    error: result.ok ? undefined : result.error,
    sanitized: result.sanitized === true || undefined,
  });
}

export function stampStepMeta(result: ToolResult, stepId?: string): ToolResult {
  if (!stepId) return result;
  return { ...result, meta: { ...(result.meta ?? {}), stepId } };
}

export function failureResult(callId: string, stepId: string | undefined, error?: string): ToolResult {
  return stampStepMeta({ callId, ok: false, error }, stepId);
}

export function persistToolCalls(
  ctx: RunContext,
  produced: RunContext['produced'],
  calls: ToolCall[],
  reasoningContent?: string,
): void {
  const durableCalls = calls.map((call) => {
    const tool = ctx.tools.find((candidate) => candidate.name === call.name);
    // `rawArguments` is kept only when the tool declares no input projector: the
    // parsed input is then persisted verbatim anyway, so the raw string adds the
    // exact bytes a later run needs without bypassing a redaction.
    const projectsInput = typeof tool?.persistence?.projectInput === 'function';
    const { rawArguments, ...rest } = call;
    return {
      ...rest,
      ...(!projectsInput && rawArguments ? { rawArguments } : {}),
      input: tool ? projectToolInput(tool, call.input) : { redacted: true, unknownTool: true },
    };
  });
  produced.push({
    id: randomUUID(),
    role: 'assistant',
    content: [
      { type: 'tool_calls', calls: durableCalls },
      // The Provider's reasoning travels with the assistant turn: the request
      // echoes it, so replaying the task interval has to carry the same text or
      // the replayed message would not match the cached one.
      ...(reasoningContent ? [{ type: 'reasoning' as const, text: reasoningContent }] : []),
    ],
    timestamp: new Date().toISOString(),
    sessionId: ctx.sessionId,
    runId: ctx.runId,
    stage: 'execute',
  });
}

export async function recordDurableToolCalls(
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

export function persistToolResult(
  ctx: RunContext,
  produced: RunContext['produced'],
  result: ToolResult,
  modelContent?: string,
): void {
  // External page bodies are allowed into one run's model context and nowhere
  // else: durable evidence keeps only the bounded citation projection, so a web
  // result never stores the text the model saw. Local tool results are already
  // persisted through `output`, so replaying their model form adds no exposure.
  const replayable = modelContent && !result.webEvidence ? modelContent : undefined;
  produced.push({
    id: randomUUID(),
    role: 'tool',
    content: [{ type: 'tool_result', result, ...(replayable ? { modelContent: replayable } : {}) }],
    timestamp: new Date().toISOString(),
    sessionId: ctx.sessionId,
    runId: ctx.runId,
    stage: 'execute',
  });
}
