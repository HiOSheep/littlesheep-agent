// Persist and project one tool round: what the model proposed, what came back,
// and the single bounded form each of them takes in the transcript and in the
// durable event log.
//
// The loop owns *when* a round is recorded; this module owns *what a record looks
// like*. Tool inputs are projected through the tool's own projector so a secret
// never reaches the transcript, and a result is reduced to the fields the next
// model turn actually needs.
import { createHash, randomUUID } from 'node:crypto';
import type { ChatMessage } from '@littlesheep/llm';
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

/**
 * The bounded result shape the model sees for one tool call.
 *
 * It carries only what a next turn can act on: whether the call succeeded, the
 * output, an error, whether the output was truncated, and the step it belongs to.
 * `status` and `durationMs` used to travel too; they were pure framing (measured
 * on the frozen real-long-task runs: 8.7k of 43.6k tool-result characters, 20%,
 * were wrapper text) and no decision the model makes depends on them.
 */
export function toolResultForModel(result: ToolResult): string {
  const output = result.modelOutput ?? result.output;
  const stepId = typeof result.meta?.stepId === 'string' ? result.meta.stepId : undefined;
  return safeStringify({
    ok: result.ok,
    // A failed call keeps its output too. For a command runner the exit code alone
    // says nothing about what failed: dropping the captured stdout/stderr left the
    // model unable to diagnose a failing test, while the runtime still recorded the
    // output as evidence. The result is already bounded by the tool and sanitizer.
    ...(typeof output === 'string' && output.length > 0 ? { output } : {}),
    ...(result.ok ? {} : { error: result.error }),
    ...(result.sanitized === true ? { sanitized: true } : {}),
    ...(stepId ? { stepId } : {}),
  });
}

/** Below this size a duplicate reference costs about as much as the content. */
const REPEATED_PAYLOAD_MIN_CHARS = 400;

/**
 * The tool payloads the conversation already carries, so a repeated read can
 * reference the earlier copy instead of sending the bytes again. Built from the
 * replayed transcript and kept up to date as this run appends rounds.
 */
export function sentToolOutputs(ctx: Pick<RunContext, 'modelHistory'>): Map<string, string> {
  const payloads = new Map<string, string>();
  for (const message of ctx.modelHistory ?? []) {
    if (message.role !== 'tool') continue;
    const part = message.content.find((block) => block.type === 'tool_result');
    if (part?.type !== 'tool_result') continue;
    if (!part.result.ok || typeof part.result.output !== 'string') continue;
    payloads.set(part.result.output, part.result.callId);
  }
  return payloads;
}

/**
 * The model-facing content for one result: the full projected result, or a
 * reference to an earlier identical payload the conversation still carries.
 *
 * Sending the bytes twice adds new input without adding information, and for a
 * re-read of a large file the whole payload is the duplicate. Small payloads keep
 * their plain form — a reference would cost as much as the content.
 */
export function modelContentForResult(result: ToolResult, sent: Map<string, string>): string {
  const full = toolResultForModel(result);
  if (!result.ok || typeof result.output !== 'string' || full.length < REPEATED_PAYLOAD_MIN_CHARS) {
    return full;
  }
  const prior = sent.get(result.output);
  if (!prior) {
    sent.set(result.output, result.callId);
    return full;
  }
  return safeStringify({
    ok: true,
    unchanged: true,
    sameAs: prior,
    note: 'identical to an earlier result still present in this conversation',
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
  text?: string,
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
      // The preamble the model wrote before calling tools is part of the cached
      // prefix too: dropping it made the replayed assistant message differ from the
      // one the Provider saw at its very first byte (measured: cross-run divergence
      // at that message, 2,653 uncached tokens on the next turn's first request).
      ...(text ? [{ type: 'text' as const, text }] : []),
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

/**
 * Persist the Runtime tail messages at the position they were sent.
 *
 * The tail (bootstrap facts, Runtime facts, retrieval contract, KnownState rules)
 * travels between the user turn and the first tool round. Without it in the
 * transcript a later run cannot replay the request, and the Provider stops
 * matching at the first tail message: measured on frozen A1, replaying the tool
 * pairs alone grew the turn boundary by 528 prompt tokens with *no* extra cached
 * tokens. Marked `runtimeTail` so no prose, UI or continuity projection treats a
 * Runtime fact as conversation.
 */
export function persistRuntimeTailMessages(
  ctx: RunContext,
  produced: RunContext['produced'],
  messages: readonly { role: string; content: unknown }[],
  entries: readonly { id: string }[] = [],
): void {
  for (const [index, message] of messages.entries()) {
    if (typeof message.content !== 'string') continue;
    const entryId = entries[index]?.id;
    produced.push({
      id: randomUUID(),
      role: message.role === 'assistant' || message.role === 'system' || message.role === 'tool'
        ? message.role
        : 'system',
      content: [{ type: 'text', text: message.content }],
      timestamp: new Date().toISOString(),
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      stage: 'execute',
      runtimeTail: true,
      ...(entryId ? { runtimeTailId: entryId } : {}),
    });
  }
}

/**
 * Runtime control messages the loop sends inside a request. They are part of the
 * bytes the Provider caches, so each one is persisted with the transcript; an
 * unrecorded one made the next run's replay stop at the previous request's last
 * message (measured: frozen A2 turn boundary diff@19 of 20).
 */
export const RUNTIME_CONTROL_MESSAGES = {
  boundaryFailure: 'Runtime control: the latest tool boundary failed. Do not call another tool in this step. Return a concise step result that preserves the failure and uncertainty for VERIFY/RECOVER.',
  effectfulFailure: 'Runtime control: the failed call may already have changed the workspace, so the Runtime will not replay it. Observe the actual state (read or list what the call was supposed to change) before deciding what to do next.',
  noProgressBound: 'Runtime control: the last rounds added no new evidence (same tool sources and targets). You can answer from the evidence already present, or say plainly what is still missing; tools are no longer available in this run.',
  iterationBudgetExhausted: 'Runtime control: this run\'s tool-loop iteration budget is spent, so no further tool call will run. Report what is already done, what the recorded evidence shows, and what still remains.',
  verifyGap: 'Runtime control: VERIFY found that the recorded evidence cannot settle this run, and this loop was re-entered so the gap can be closed. A call that was refused before it ran leaves no usable evidence; repeating it with the same arguments will be refused again. Fix the call or take the missing observation with a valid one, then report what the evidence now shows.',
} as const;

/**
 * Tell the model why the loop was re-entered after a VERIFY gap.
 *
 * RECOVER sends a structural VERIFY gap back to the loop once, so the model can
 * close it; the failed call's own error is in the transcript, but nothing there
 * says the run was sent back for it. The gap closes when a later successful call
 * in the same step supersedes the refused one, so the message names that rather
 * than ordering a retry. A loop that was not re-entered emits nothing.
 */
export function persistVerifyGapControl(
  ctx: RunContext,
  produced: RunContext['produced'],
  messages: ChatMessage[],
): void {
  if (ctx.lastError?.stage !== 'verify') return;
  const record = ctx.verificationHistory?.at(-1);
  if (record?.verdict !== 'fail' || record.source !== 'structural') return;
  persistRuntimeControlMessage(ctx, produced, messages, RUNTIME_CONTROL_MESSAGES.verifyGap);
}

/** Append one Runtime control message to the live request and to the transcript. */
export function persistRuntimeControlMessage(
  ctx: RunContext,
  produced: RunContext['produced'],
  messages: ChatMessage[],
  text: string,
): void {
  messages.push({ role: 'system', content: text });
  persistRuntimeTailMessages(ctx, produced, [{ role: 'system', content: text }]);
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
