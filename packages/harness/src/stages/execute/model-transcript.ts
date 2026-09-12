// Next-Harness ordered transcript.
//
// The durable path publishes the model's own thinking and the per-turn
// assistant prose so the conversation can render thinking / tool / text rows in
// production order. The legacy Harness never enables this: it keeps its
// previous event sequence and display contract.
import type { ChatRequest, ChatResponse, LlmClient, StreamChunk } from '@littlesheep/llm';
import type { RunContext, ToolStreamEvent } from '@littlesheep/types';
import { callModelChat, callModelChatStream } from '../../model-observability.js';

/** Bounded per-row transcript text; the UI never receives unbounded model text. */
const MAX_TRANSCRIPT_TEXT_LENGTH = 4_000;

export interface TranscriptTurn {
  enabled: boolean;
  phaseId: string;
  reasoning: string;
  text: string;
  preparingToolName?: string;
  preparingToolChars: number;
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
    text: '',
    preparingToolChars: 0,
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
      summary: turn.reasoning,
    });
  }
  if (turn.text.trim() && finishReason === 'tool_calls') {
    emitTranscript(ctx, {
      type: 'model_text',
      phaseId: turn.phaseId,
      reasoningStatus: 'done',
      summary: turn.text.trim(),
    });
    // Tool-turn prose belongs in the process transcript, not in the live final
    // answer bubble. Retract the provisional stream before the tool starts.
    ctx.onAssistantReplace?.('');
  }
  if (turn.preparingToolChars > 0) {
    emitTranscript(ctx, {
      type: 'model_reasoning',
      phaseId: `${turn.phaseId}:tool-preparing`,
      reasoningStatus: 'done',
      summary: toolPreparationSummary(turn),
    });
  }
}

function collectTranscriptChunk(
  ctx: RunContext,
  turn: TranscriptTurn,
  chunk: StreamChunk,
): void {
  if (chunk.type === 'reset') {
    turn.reasoning = '';
    turn.text = '';
    turn.preparingToolName = undefined;
    turn.preparingToolChars = 0;
    ctx.onAssistantReplace?.('');
    return;
  }
  if (chunk.type === 'reasoning_delta' && chunk.delta) {
    turn.reasoning = boundedTranscriptText(turn.reasoning + chunk.delta);
    // Thinking arrives before the tool decision it explains; the renderer
    // appends these deltas into one ordered row per turn.
    emitTranscript(ctx, {
      type: 'model_reasoning',
      phaseId: turn.phaseId,
      reasoningStatus: 'running',
      summary: chunk.delta,
    });
    return;
  }
  if (chunk.type === 'delta' && chunk.delta) {
    turn.text = boundedTranscriptText(turn.text + chunk.delta);
    // EXECUTE uses the same assistant preview channel as direct REPLY so the
    // final model turn paints while tokens arrive instead of at run settlement.
    ctx.onAssistantDelta?.(chunk.delta);
    return;
  }
  if (chunk.type === 'tool_call_delta') {
    if (chunk.toolCallName) turn.preparingToolName = chunk.toolCallName;
    turn.preparingToolChars += chunk.toolCallArgsDelta?.length ?? 0;
    emitTranscript(ctx, {
      type: 'model_reasoning',
      phaseId: `${turn.phaseId}:tool-preparing`,
      reasoningStatus: 'running',
      summary: toolPreparationSummary(turn),
    });
  }
}

function toolPreparationSummary(turn: TranscriptTurn): string {
  const amount = turn.preparingToolChars >= 1024
    ? `${(turn.preparingToolChars / 1024).toFixed(1)} KB`
    : `${turn.preparingToolChars} B`;
  return `正在准备 ${turn.preparingToolName ?? '工具'} 调用 · 已生成 ${amount} 参数`;
}

function boundedTranscriptText(value: string): string {
  return value.length > MAX_TRANSCRIPT_TEXT_LENGTH ? value.slice(-MAX_TRANSCRIPT_TEXT_LENGTH) : value;
}

function emitTranscript(ctx: RunContext, event: ToolStreamEvent): void {
  try {
    ctx.onToolEvent?.({ ...event, visibility: 'progress', stage: 'execute' });
  } catch {
    // Transcript delivery is cosmetic; a stream failure must not fail the run.
  }
}
