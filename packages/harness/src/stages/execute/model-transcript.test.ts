import { describe, expect, it } from 'vitest';
import type { ChatRequest, LlmClient } from '@littlesheep/llm';
import type { ToolStreamEvent } from '@littlesheep/types';
import { makeCtx } from '../../tests/helpers.js';
import {
  abortTranscriptTurn,
  closeTranscriptTurn,
  createTranscriptTurn,
  runTranscriptModelTurn,
} from './model-transcript.js';

const request: ChatRequest = { model: 'test', messages: [{ role: 'user', content: 'work' }] };

describe('model transcript closure', () => {
  it('HA-04-04 closes reasoning and tool preparation when the stream fails', async () => {
    const events: ToolStreamEvent[] = [];
    const replacements: string[] = [];
    const ctx = makeCtx();
    ctx.streamModelTranscript = true;
    ctx.onToolEvent = (event) => events.push(event);
    ctx.onAssistantReplace = (text) => replacements.push(text);
    const llm = {
      chatStream: async (_request, onDelta) => {
        onDelta({ type: 'reasoning_delta', delta: '正在判断' });
        onDelta({ type: 'tool_call_delta', toolCallIndex: 0, toolCallName: 'read', toolCallArgsDelta: '{"path":' });
        throw new Error('stream broke');
      },
    } as LlmClient;
    const turn = createTranscriptTurn(ctx, 'step', 1);

    await expect(runTranscriptModelTurn(ctx, llm, request, turn)).rejects.toThrow('stream broke');
    abortTranscriptTurn(ctx, turn, 'failed');

    expect(events.filter((event) => event.type === 'model_reasoning').map((event) => event.reasoningStatus))
      .toEqual(['running', 'failed']);
    expect(events.filter((event) => event.type === 'tool_preparing').map((event) => event.generationStatus))
      .toEqual(['running', 'failed']);
    expect(replacements.at(-1)).toBe('');
  });

  it('closes a successful stop turn instead of leaving reasoning running', async () => {
    const events: ToolStreamEvent[] = [];
    const ctx = makeCtx();
    ctx.streamModelTranscript = true;
    ctx.onToolEvent = (event) => events.push(event);
    const llm = {
      chatStream: async (_request, onDelta) => {
        onDelta({ type: 'reasoning_delta', delta: '完成判断' });
        onDelta({ type: 'delta', delta: '最终正文' });
        return { content: '最终正文', toolCalls: [], finishReason: 'stop' as const };
      },
    } as LlmClient;
    const turn = createTranscriptTurn(ctx, 'step', 1);

    const response = await runTranscriptModelTurn(ctx, llm, request, turn);
    closeTranscriptTurn(ctx, turn, response.finishReason);

    expect(events.filter((event) => event.type === 'model_reasoning').map((event) => event.reasoningStatus))
      .toEqual(['running', 'done']);
  });

  it('marks reasoning aborted when cancellation closes a partial turn', async () => {
    const events: ToolStreamEvent[] = [];
    const ctx = makeCtx();
    ctx.streamModelTranscript = true;
    ctx.onToolEvent = (event) => events.push(event);
    const llm = {
      chatStream: async (_request, onDelta) => {
        onDelta({ type: 'reasoning_delta', delta: '正在思考' });
        return { content: '', toolCalls: [], finishReason: 'stop' as const };
      },
    } as LlmClient;
    const turn = createTranscriptTurn(ctx, 'step', 1);

    await runTranscriptModelTurn(ctx, llm, request, turn);
    abortTranscriptTurn(ctx, turn, 'aborted');

    expect(events.filter((event) => event.type === 'model_reasoning').at(-1)?.reasoningStatus)
      .toBe('aborted');
  });

  it('HA-04-09 bounds 100,000 tiny reasoning and argument fragments', async () => {
    const events: ToolStreamEvent[] = [];
    const ctx = makeCtx();
    ctx.streamModelTranscript = true;
    ctx.onToolEvent = (event) => events.push(event);
    const llm = {
      chatStream: async (_request, onDelta) => {
        for (let index = 0; index < 100_000; index += 1) {
          onDelta({ type: 'reasoning_delta', delta: index % 2 === 0 ? '\u7f8a' : '\ud83d\udc11' });
          onDelta({
            type: 'tool_call_delta',
            toolCallIndex: 0,
            toolCallName: index === 0 ? 'read' : undefined,
            toolCallArgsDelta: 'x',
          });
        }
        return {
          content: '',
          toolCalls: [{ id: 'call-1', name: 'read', input: { value: 'x'.repeat(100_000) } }],
          finishReason: 'tool_calls' as const,
        };
      },
    } as LlmClient;
    const turn = createTranscriptTurn(ctx, 'step', 1);

    const response = await runTranscriptModelTurn(ctx, llm, request, turn);
    closeTranscriptTurn(ctx, turn, response.finishReason);

    const reasoningEvents = events.filter((event) => event.type === 'model_reasoning');
    const preparingEvents = events.filter((event) => event.type === 'tool_preparing');
    expect(reasoningEvents.length).toBeLessThan(100);
    expect(reasoningEvents.at(-1)?.summary).toContain('[truncated]');
    expect(reasoningEvents.at(-1)?.summary?.length).toBeLessThanOrEqual(4_000);
    expect(preparingEvents.length).toBeLessThan(2_000);
    expect(preparingEvents.at(-1)?.receivedCharacters).toBe(100_000);
    expect(preparingEvents.at(-1)?.generationStatus).toBe('done');
  });

  it('HA-04-03 keeps interleaved tool preparation rows independent', async () => {
    const events: ToolStreamEvent[] = [];
    const ctx = makeCtx();
    ctx.streamModelTranscript = true;
    ctx.onToolEvent = (event) => events.push(event);
    const llm = {
      chatStream: async (_request, onDelta) => {
        onDelta({ type: 'tool_call_delta', toolCallIndex: 0, toolCallName: 're', toolCallArgsDelta: '{' });
        onDelta({ type: 'tool_call_delta', toolCallIndex: 1, toolCallName: 'ex', toolCallArgsDelta: '{"c' });
        onDelta({ type: 'tool_call_delta', toolCallIndex: 0, toolCallName: 'ad', toolCallArgsDelta: '}' });
        onDelta({ type: 'tool_call_delta', toolCallIndex: 1, toolCallName: 'ec', toolCallArgsDelta: 'md":1}' });
        return {
          content: '',
          toolCalls: [
            { id: 'read-1', name: 'read', input: {} },
            { id: 'exec-1', name: 'exec', input: { cmd: 1 } },
          ],
          finishReason: 'tool_calls' as const,
        };
      },
    } as LlmClient;
    const turn = createTranscriptTurn(ctx, 'step', 1);

    const response = await runTranscriptModelTurn(ctx, llm, request, turn);
    closeTranscriptTurn(ctx, turn, response.finishReason);

    const finalRows = events.filter((event) => event.type === 'tool_preparing' && event.generationStatus === 'done');
    expect(finalRows).toEqual([
      expect.objectContaining({ toolCallIndex: 0, name: 'read', receivedCharacters: 2 }),
      expect.objectContaining({ toolCallIndex: 1, name: 'exec', receivedCharacters: 9 }),
    ]);
  });
});
