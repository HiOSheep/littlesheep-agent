// @littlesheep/harness — cross-run continuation across a task interval.
//
// A new run must extend the previous run's request instead of rebuilding a
// shorter history: the Provider's prefix cache only matches from token zero, so
// dropping the tool calls and their results re-billed the whole context on every
// turn (measured on the frozen real long tasks: -516/-1015 prompt tokens and
// 3.0k-6.4k rebuilt tokens per task).
import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '@littlesheep/llm';
import { createExecuteStage } from './execute.js';
import { createMockLlm, makeCtx, makeTool, textResponse } from '../tests/helpers.js';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { textMessage } from '@littlesheep/types';
import type { Message } from '@littlesheep/types';

const deps = { model: 'test', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING };

/** A mock LLM that records every request it is asked to send. */
function recordingLlm(reply: string): { llm: ReturnType<typeof createMockLlm>; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const llm = createMockLlm((request) => {
    requests.push(request);
    return textResponse(reply);
  });
  return { llm, requests };
}

function priorTurnMessages(): Message[] {
  return [
    textMessage('user', '先读懂代码，先不要改代码。'),
    {
      id: 'assistant-tool-calls',
      role: 'assistant',
      timestamp: '2026-09-22T00:00:01.000Z',
      runId: 'previous-run',
      stage: 'execute',
      content: [
        { type: 'text', text: '' },
        {
          type: 'tool_calls',
          calls: [{
            id: 'call-1',
            name: 'read',
            input: { file_path: 'src/cart.mjs' },
            rawArguments: '{"file_path":"src/cart.mjs"}',
          }],
        },
        { type: 'reasoning', text: '先看实现' },
      ],
    },
    {
      id: 'tool-result',
      role: 'tool',
      timestamp: '2026-09-22T00:00:02.000Z',
      runId: 'previous-run',
      stage: 'execute',
      content: [{
        type: 'tool_result',
        result: { callId: 'call-1', ok: true, output: 'export const cartTotal = 1' },
        modelContent: '{"ok":true,"status":"succeeded","output":"export const cartTotal = 1"}',
      }],
    },
    {
      id: 'assistant-answer',
      role: 'assistant',
      timestamp: '2026-09-22T00:00:03.000Z',
      runId: 'previous-run',
      stage: 'finalize',
      content: [{ type: 'text', text: '优惠券在税后扣减，失败用例是边界用例。' }],
    },
  ];
}

describe('cross-run continuation', () => {
  it('replays the previous turn tool pair before the new user message', async () => {
    const tool = makeTool('read', { ok: true, output: 'unused' });
    const { llm, requests } = recordingLlm('已修复。');
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', '修好它') });
    ctx.modelHistory = priorTurnMessages();

    const res = await stage(ctx);

    expect(res.next).toBe('verify');
    const request = requests[0]!;
    const assistantToolCall = request.messages.find((message) => (
      message.role === 'assistant' && Array.isArray(message.tool_calls)
    ));
    expect(assistantToolCall).toMatchObject({
      content: '',
      reasoning_content: '先看实现',
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'read', arguments: '{"file_path":"src/cart.mjs"}' },
      }],
    });
    const toolMessage = request.messages.find((message) => message.role === 'tool');
    expect(toolMessage).toMatchObject({
      tool_call_id: 'call-1',
      content: '{"ok":true,"status":"succeeded","output":"export const cartTotal = 1"}',
    });
    // The replayed pair precedes the new user message, and the previous answer is
    // part of the history the new request extends.
    const toolIndex = request.messages.findIndex((message) => message.role === 'tool');
    const inboundIndex = request.messages.findIndex((message) => (
      message.role === 'user' && message.content === '修好它'
    ));
    expect(toolIndex).toBeGreaterThan(0);
    expect(inboundIndex).toBeGreaterThan(toolIndex);
    expect(request.messages.some((message) => (
      typeof message.content === 'string' && message.content.includes('失败用例是边界用例')
    ))).toBe(true);
  });

  it('does not throw when a persisted message has no replayable content', async () => {
    const { llm, requests } = recordingLlm('好的。');
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', '继续') });
    // A message shape older sessions can contain: no text, no tool parts.
    ctx.modelHistory = [{
      id: 'empty',
      role: 'assistant',
      timestamp: '2026-09-22T00:00:00.000Z',
      content: [],
    }];

    const res = await stage(ctx);

    expect(res.ok).toBe(true);
    // The runtime tail follows the user turn, so the inbound message is the last
    // user message rather than the last message.
    const inbound = [...requests[0]!.messages].reverse().find((message) => message.role === 'user');
    expect(inbound).toMatchObject({ role: 'user', content: '继续' });
  });
});
