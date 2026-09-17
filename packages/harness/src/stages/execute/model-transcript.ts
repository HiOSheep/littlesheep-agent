// Next-Harness ordered transcript.
//
// The durable path publishes the model's own thinking and the per-turn
// assistant prose so the conversation can render thinking / tool / text rows in
// production order. The legacy Harness never enables this: it keeps its
// previous event sequence and display contract.
import type { ChatRequest, ChatResponse, LlmClient, StreamChunk } from '@littlesheep/llm';
import type { RunContext, ToolStreamEvent } from '@littlesheep/types';
import { callModelChat, callModelChatStream, modelRequestIdFor } from '../../model-observability.js';

/** Bounded per-row transcript text; the UI never receives unbounded model text. */
const MAX_TRANSCRIPT_TEXT_LENGTH = 4_000;
const TRANSCRIPT_PROGRESS_BATCH_CHARACTERS = 64;
const TRUNCATION_MARKER = '\u2026 [truncated]';

export interface TranscriptTurn {
  enabled: boolean;
  phaseId: string;
  reasoning: string;
  reasoningTruncated: boolean;
  pendingReasoningDelta: string;
  reasoningPublished: boolean;
  text: string;
  preparingTools: Map<number, {
    name: string;
    receivedCharacters: number;
    publishedName: string;
    publishedCharacters: number;
  }>;
  requestId?: string;
  transportAttempt: number;
  sequence: number;
}

export function createTranscriptTurn(
  ctx: RunContext,
  stepId: string | undefined,
  iteration: number,
): TranscriptTurn {
  return {
    enabled: ctx.streamModelTranscript === true && typeof ctx.onToolEvent === 'function',
    phaseId: `${stepId ?? 'execute'}:turn-${iteration}`,
    reasoning: '',
    reasoningTruncated: false,
    pendingReasoningDelta: '',
    reasoningPublished: false,
    text: '',
    preparingTools: new Map(),
    transportAttempt: 1,
    sequence: 0,
  };
}

/** Run one tool-loop turn, streaming thinking deltas when the transcript is on. */
export async function runTranscriptModelTurn(
  ctx: RunContext,
  llm: LlmClient,
  request: ChatRequest,
  turn: TranscriptTurn,
): Promise<ChatResponse> {
  if (!turn.enabled) return callModelChat(ctx, llm, request);
  turn.requestId = modelRequestIdFor(request);
  return callModelChatStream(ctx, llm, request, (chunk) => {
    collectTranscriptChunk(ctx, turn, chunk);
  });
}

/**
 * Close the turn: thinking is published once as a settled row, and prose is
 * published only for tool-calling turns because the final answer turn reaches
 * the user through the normal reply publication.
 */
export function closeTranscriptTurn(
  ctx: RunContext,
  turn: TranscriptTurn,
  finishReason: ChatResponse['finishReason'],
): void {
  if (!turn.enabled) return;
  if (turn.reasoning.trim()) {
    emitTranscript(ctx, {
      type: 'model_reasoning',
      phaseId: turn.phaseId,
      reasoningStatus: 'done',
      summary: finalizedTranscriptText(turn.reasoning, turn.reasoningTruncated),
      streamRef: nextStreamRef(ctx, turn, 'replace'),
    });
  }
  if (turn.text.trim() && finishReason === 'tool_calls') {
    emitTranscript(ctx, {
      type: 'model_text',
      phaseId: turn.phaseId,
      reasoningStatus: 'done',
      summary: turn.text.trim(),
      streamRef: nextStreamRef(ctx, turn, 'replace'),
    });
    // Tool-turn prose belongs in the process transcript, not in the live final
    // answer bubble. Retract the provisional stream before the tool starts.
    ctx.onAssistantReplace?.('');
  }
  for (const [toolCallIndex, preparing] of turn.preparingTools) {
    emitTranscript(ctx, {
      type: 'tool_preparing',
      phaseId: `${turn.phaseId}:tool-preparing:${toolCallIndex}`,
      generationStatus: 'done',
      summary: toolPreparationSummary(preparing.name, preparing.receivedCharacters),
      toolCallIndex,
      name: preparing.name || undefined,
      receivedCharacters: preparing.receivedCharacters,
      streamRef: nextStreamRef(ctx, turn, 'replace'),
    });
  }
}

/** Close partial rows when a model turn fails or is cancelled before a response. */
export function abortTranscriptTurn(
  ctx: RunContext,
  turn: TranscriptTurn,
  status: 'failed' | 'aborted',
): void {
  if (!turn.enabled) return;
  if (turn.reasoning) {
    emitTranscript(ctx, {
      type: 'model_reasoning',
      phaseId: turn.phaseId,
      reasoningStatus: status,
      summary: finalizedTranscriptText(turn.reasoning, turn.reasoningTruncated),
      streamRef: nextStreamRef(ctx, turn, 'replace'),
    });
  }
  for (const [toolCallIndex, preparing] of turn.preparingTools) {
    emitTranscript(ctx, {
      type: 'tool_preparing',
      phaseId: `${turn.phaseId}:tool-preparing:${toolCallIndex}`,
      generationStatus: status,
      summary: toolPreparationSummary(preparing.name, preparing.receivedCharacters),
      toolCallIndex,
      name: preparing.name || undefined,
      receivedCharacters: preparing.receivedCharacters,
      streamRef: nextStreamRef(ctx, turn, 'replace'),
    });
  }
  ctx.onAssistantReplace?.('');
}

function collectTranscriptChunk(
  ctx: RunContext,
  turn: TranscriptTurn,
  chunk: StreamChunk,
): void {
  if (chunk.type === 'reset') {
    if (chunk.transportAttempt) turn.transportAttempt = chunk.transportAttempt;
    turn.sequence = 0;
    emitTranscript(ctx, {
      type: 'model_reasoning',
      phaseId: turn.phaseId,
      reasoningStatus: 'running',
      summary: '',
      streamRef: nextStreamRef(ctx, turn, 'reset'),
    });
    for (const toolCallIndex of turn.preparingTools.keys()) {
      emitTranscript(ctx, {
        type: 'tool_preparing',
        phaseId: `${turn.phaseId}:tool-preparing:${toolCallIndex}`,
        generationStatus: 'aborted',
        summary: '',
        toolCallIndex,
        receivedCharacters: 0,
        streamRef: nextStreamRef(ctx, turn, 'reset'),
      });
    }
    turn.reasoning = '';
    turn.reasoningTruncated = false;
    turn.pendingReasoningDelta = '';
    turn.reasoningPublished = false;
    turn.text = '';
    turn.preparingTools.clear();
    ctx.onAssistantReplace?.('');
    return;
  }
  if (chunk.type === 'reasoning_delta' && chunk.delta) {
    if (chunk.transportAttempt && chunk.transportAttempt !== turn.transportAttempt) {
      turn.transportAttempt = chunk.transportAttempt;
      turn.sequence = 0;
    }
    const appended = appendBoundedTranscriptText(turn.reasoning, chunk.delta);
    turn.reasoning = appended.text;
    turn.reasoningTruncated ||= appended.truncated;
    turn.pendingReasoningDelta += appended.acceptedDelta;
    // Publish the first real fragment immediately. Afterwards batch tiny
    // provider fragments so Renderer work stays bounded; close/reset always
    // sends an authoritative snapshot.
    if (!turn.reasoningPublished || turn.pendingReasoningDelta.length >= TRANSCRIPT_PROGRESS_BATCH_CHARACTERS) {
      emitTranscript(ctx, {
        type: 'model_reasoning',
        phaseId: turn.phaseId,
        reasoningStatus: 'running',
        summary: turn.pendingReasoningDelta,
        streamRef: nextStreamRef(ctx, turn, 'append'),
      });
      turn.pendingReasoningDelta = '';
      turn.reasoningPublished = true;
    }
    return;
  }
  if (chunk.type === 'delta' && chunk.delta) {
    turn.text = appendBoundedTranscriptText(turn.text, chunk.delta).text;
    // EXECUTE uses the same assistant preview channel as direct REPLY so the
    // final model turn paints while tokens arrive instead of at run settlement.
    ctx.onAssistantDelta?.(chunk.delta);
    return;
  }
  if (chunk.type === 'tool_call_delta') {
    if (chunk.transportAttempt && chunk.transportAttempt !== turn.transportAttempt) {
      turn.transportAttempt = chunk.transportAttempt;
      turn.sequence = 0;
    }
    const toolCallIndex = chunk.toolCallIndex ?? 0;
    const previous = turn.preparingTools.get(toolCallIndex) ?? {
      name: '',
      receivedCharacters: 0,
      publishedName: '',
      publishedCharacters: 0,
    };
    const preparing = {
      name: previous.name + (chunk.toolCallName ?? ''),
      receivedCharacters: previous.receivedCharacters + (chunk.toolCallArgsDelta?.length ?? 0),
      publishedName: previous.publishedName,
      publishedCharacters: previous.publishedCharacters,
    };
    turn.preparingTools.set(toolCallIndex, preparing);
    const firstPublication = preparing.publishedCharacters === 0 && !preparing.publishedName;
    const nameCompleted = preparing.name !== preparing.publishedName && !chunk.toolCallArgsDelta;
    const enoughNewArguments = preparing.receivedCharacters - preparing.publishedCharacters
      >= TRANSCRIPT_PROGRESS_BATCH_CHARACTERS;
    if (firstPublication || nameCompleted || enoughNewArguments) {
      emitTranscript(ctx, {
        type: 'tool_preparing',
        phaseId: `${turn.phaseId}:tool-preparing:${toolCallIndex}`,
        generationStatus: 'running',
        summary: toolPreparationSummary(preparing.name, preparing.receivedCharacters),
        toolCallIndex,
        name: preparing.name || undefined,
        receivedCharacters: preparing.receivedCharacters,
        streamRef: nextStreamRef(ctx, turn, 'replace'),
      });
      preparing.publishedName = preparing.name;
      preparing.publishedCharacters = preparing.receivedCharacters;
    }
  }
}

function nextStreamRef(
  ctx: RunContext,
  turn: TranscriptTurn,
  operation: 'append' | 'replace' | 'reset',
): NonNullable<ToolStreamEvent['streamRef']> | undefined {
  if (!turn.requestId) return undefined;
  return {
    version: 1,
    runId: ctx.runId,
    requestId: turn.requestId,
    transportAttempt: turn.transportAttempt,
    sequence: ++turn.sequence,
    operation,
  };
}

function toolPreparationSummary(name: string, receivedCharacters: number): string {
  return `正在准备 ${name || '工具'} 调用 · 已生成 ${receivedCharacters} 个字符参数`;
}

function appendBoundedTranscriptText(
  current: string,
  delta: string,
): { text: string; acceptedDelta: string; truncated: boolean } {
  const remaining = Math.max(0, MAX_TRANSCRIPT_TEXT_LENGTH - current.length);
  const acceptedDelta = remaining > 0 ? delta.slice(0, remaining) : '';
  return {
    text: current + acceptedDelta,
    acceptedDelta,
    truncated: delta.length > acceptedDelta.length,
  };
}

function finalizedTranscriptText(value: string, truncated: boolean): string {
  if (!truncated) return value;
  return `${value.slice(0, Math.max(0, MAX_TRANSCRIPT_TEXT_LENGTH - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
}

function emitTranscript(ctx: RunContext, event: ToolStreamEvent): void {
  try {
    ctx.onToolEvent?.({ ...event, visibility: 'progress', stage: 'execute' });
  } catch {
    // Transcript delivery is cosmetic; a stream failure must not fail the run.
  }
}
