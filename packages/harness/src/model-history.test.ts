import { describe, expect, it } from 'vitest';
import type { Message, RunContext } from '@littlesheep/types';
import { textMessage } from '@littlesheep/types';
import {
  MODEL_HISTORY_MAX_CHARS,
  modelHistoryMessages,
  projectModelHistory,
  replayCharBudget,
} from './model-history.js';

function toolCallsMessage(options: {
  text?: string;
  reasoning?: string;
  calls: Array<{ id: string; name: string; input: unknown; rawArguments?: string }>;
}): Message {
  return {
    id: `assistant-${options.calls[0]?.id ?? 'x'}`,
    role: 'assistant',
    timestamp: '2026-09-22T00:00:00.000Z',
    content: [
      ...(options.text ? [{ type: 'text' as const, text: options.text }] : []),
      { type: 'tool_calls', calls: options.calls },
      ...(options.reasoning ? [{ type: 'reasoning' as const, text: options.reasoning }] : []),
    ],
  };
}

function toolResultMessage(callId: string, options: { modelContent?: string; output?: string } = {}): Message {
  return {
    id: `tool-${callId}`,
    role: 'tool',
    timestamp: '2026-09-22T00:00:01.000Z',
    content: [{
      type: 'tool_result',
      result: { callId, ok: true, output: options.output ?? 'result output' },
      ...(options.modelContent ? { modelContent: options.modelContent } : {}),
    }],
  };
}

describe('task-interval model history', () => {
  it('replays the assistant tool call and its result with the bytes the Provider saw', () => {
    const history = projectModelHistory([
      textMessage('user', 'read the file'),
      toolCallsMessage({
        calls: [{ id: 'c1', name: 'read', input: { file_path: '/x' }, rawArguments: '{"file_path": "/x"}' }],
      }),
      toolResultMessage('c1', { modelContent: '{"ok":true,"output":"file body"}' }),
      textMessage('assistant', 'the file says hello'),
    ]);

    expect(history).toEqual([
      { role: 'user', content: 'read the file' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'c1',
          type: 'function',
          // The raw string, not a re-serialization of the parsed object.
          function: { name: 'read', arguments: '{"file_path": "/x"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true,"output":"file body"}' },
      { role: 'assistant', content: 'the file says hello' },
    ]);
  });

  it('keeps the Provider reasoning that the request echoes for the same turn', () => {
    const history = projectModelHistory([
      toolCallsMessage({
        reasoning: 'provider reasoning must be preserved',
        calls: [{ id: 'c1', name: 'read', input: {} }],
      }),
      toolResultMessage('c1'),
    ]);

    expect(history[0]).toMatchObject({
      role: 'assistant',
      reasoning_content: 'provider reasoning must be preserved',
    });
  });

  it('drops orphan results and incomplete call groups instead of emitting an invalid request', () => {
    const history = projectModelHistory([
      // A result whose call is missing.
      toolResultMessage('orphan'),
      // A call whose result never arrived.
      toolCallsMessage({ calls: [{ id: 'c2', name: 'read', input: {} }] }),
      textMessage('user', 'next question'),
    ]);

    expect(history).toEqual([{ role: 'user', content: 'next question' }]);
  });

  it('falls back to the prose projection when a run has no task-interval history', () => {
    const ctx = {
      history: [textMessage('user', 'hello'), textMessage('assistant', 'hi')],
    };
    expect(modelHistoryMessages(ctx)).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    expect(modelHistoryMessages({ ...ctx, modelHistory: [] })).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
  });

  it('bounds the replay at call-group boundaries only', () => {
    const messages: Message[] = [textMessage('user', 'small')];
    for (let index = 0; index < 6; index += 1) {
      messages.push(toolCallsMessage({ calls: [{ id: `c${index}`, name: 'read', input: {} }] }));
      messages.push(toolResultMessage(`c${index}`, { modelContent: 'x'.repeat(500) }));
    }

    const history = projectModelHistory(messages, 1_000);

    // The newest group is always kept, and no call is left without its result.
    expect(history.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c5' });
    for (const [index, message] of history.entries()) {
      if (message.role !== 'assistant' || !message.tool_calls) continue;
      const callId = message.tool_calls[0]!.id;
      expect(history[index + 1]).toMatchObject({ role: 'tool', tool_call_id: callId });
    }
    expect(JSON.stringify(history).length).toBeLessThanOrEqual(MODEL_HISTORY_MAX_CHARS);
  });

  it('derives the replay ceiling from the model budget instead of a fixed character cap', () => {
    const modelHistory = [
      textMessage('user', 'x'.repeat(100_000)),
      textMessage('assistant', 'the recent turn'),
    ];

    // No known budget: the documented fallback ceiling applies and the oldest
    // group falls off it.
    expect(replayCharBudget({})).toBe(MODEL_HISTORY_MAX_CHARS);
    expect(modelHistoryMessages({ history: [], modelHistory })).toHaveLength(1);

    // A known budget makes the engine's token accounting the bound, so the replay is
    // not truncated here at all — a ceiling derived at 2 chars/token still dropped
    // 21 messages in one turn of the long task.
    const contextSnapshots = [
      { budget: { status: 'unknown', reason: 'unregistered' } },
      { budget: { status: 'known', maxContextTokens: 128_000, reservedOutputTokens: 8_000, availablePromptTokens: 120_000, compressionThresholdRatio: 0.8 } },
    ] as unknown as NonNullable<RunContext['contextSnapshots']>;
    expect(replayCharBudget({ contextSnapshots })).toBe(Number.POSITIVE_INFINITY);
    expect(modelHistoryMessages({ history: [], modelHistory, contextSnapshots })).toHaveLength(2);
  });

  it('replays the assistant preamble that accompanied a tool call', () => {
    const history = projectModelHistory([
      toolCallsMessage({
        text: '我先读一下实现。',
        reasoning: 'think first',
        calls: [{ id: 'c1', name: 'read', input: {}, rawArguments: '{}' }],
      }),
      toolResultMessage('c1'),
    ]);

    // The preamble is part of the bytes the Provider cached; dropping it made the
    // replayed assistant message differ at its first byte.
    expect(history[0]).toMatchObject({
      role: 'assistant',
      content: '我先读一下实现。',
      reasoning_content: 'think first',
    });
  });

  it('replays a persisted Runtime tail section in the position it was sent', () => {
    const tail: Message = {
      id: 'tail-1',
      role: 'system',
      timestamp: '2026-09-22T00:00:00.500Z',
      content: [{ type: 'text', text: 'Runtime facts: capability_permission_decision: allow' }],
      runtimeTail: true,
    };
    const history = projectModelHistory([
      textMessage('user', '修好它'),
      tail,
      toolCallsMessage({ calls: [{ id: 'c1', name: 'read', input: {}, rawArguments: '{}' }] }),
      toolResultMessage('c1'),
    ]);

    // The tail sits between the user turn and the tool round exactly as it did in
    // the request the Provider cached; without it the prefix would diverge there
    // and every replayed byte after it would be billed again.
    expect(history.map((message) => message.role)).toEqual(['user', 'system', 'assistant', 'tool']);
    expect(history[1]).toEqual({
      role: 'system',
      content: 'Runtime facts: capability_permission_decision: allow',
    });
  });

  it('makes the next run extend the previous run request instead of rebuilding it', () => {
    // Persisted transcript of one turn: user, one tool round, the final answer.
    const runOneRound: Message[] = [
      textMessage('user', '先读懂代码'),
      toolCallsMessage({
        reasoning: 'think first',
        calls: [{ id: 'call-1', name: 'read', input: { file_path: 'src/a.mjs' }, rawArguments: '{"file_path":"src/a.mjs"}' }],
      }),
      toolResultMessage('call-1', { modelContent: '{"ok":true,"output":"export const a = 1"}' }),
    ];
    const previousRequest = [
      { role: 'system' as const, content: 'SYSTEM' },
      { role: 'user' as const, content: '先读懂代码' },
      {
        role: 'assistant' as const,
        content: '',
        reasoning_content: 'think first',
        tool_calls: [{
          id: 'call-1',
          type: 'function' as const,
          function: { name: 'read', arguments: '{"file_path":"src/a.mjs"}' },
        }],
      },
      { role: 'tool' as const, tool_call_id: 'call-1', content: '{"ok":true,"output":"export const a = 1"}' },
    ];

    const nextRunHistory = projectModelHistory([
      ...runOneRound,
      textMessage('assistant', '代码已读完'),
      textMessage('user', '修好它'),
    ]);
    const nextRunRequest = [
      { role: 'system' as const, content: 'SYSTEM' },
      ...nextRunHistory,
      { role: 'user' as const, content: '修好它' },
    ];

    // The next run's request repeats the previous request byte for byte first, so
    // the Provider can reuse the cached prefix instead of re-billing the context.
    expect(nextRunRequest.slice(0, previousRequest.length)).toEqual(previousRequest);
  });
});
