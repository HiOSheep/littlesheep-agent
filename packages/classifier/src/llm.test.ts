import { describe, it, expect, vi } from 'vitest';
import { classifyByLlm } from './llm.js';
import { classify } from './index.js';
import { textMessage } from '@littlesheep/types';
import type { LlmClient, ChatResponse } from '@littlesheep/llm';

/** Build a mock LlmClient that returns given responses in sequence. */
function mockLlm(responses: ChatResponse[]): LlmClient {
  let call = 0;
  return {
    chat: vi.fn(async () => {
      const r = responses[Math.min(call, responses.length - 1)]!;
      call++;
      return r;
    }),
    chatStream: vi.fn(async () => responses[0]!),
    embed: vi.fn(async () => ({ embeddings: [], model: '', usage: { promptTokens: 0 } })),
  };
}

const baseResponse = (content: string): ChatResponse => ({
  content,
  toolCalls: [],
  finishReason: 'stop',
});

describe('classifyByLlm', () => {
  it('parses valid JSON response', async () => {
    const llm = mockLlm([baseResponse('{"type":"problem","confidence":0.9,"reason":"task"}')]);
    const msg = textMessage('user', 'do something');
    const result = await classifyByLlm(msg, [], llm, 'gpt-4o');
    expect(result.type).toBe('problem');
    expect(result.confidence).toBe(0.9);
    expect(result.source).toBe('llm');
    expect(result.reason).toBe('task');
  });

  it('extracts JSON from markdown-wrapped response', async () => {
    const llm = mockLlm([baseResponse('```json\n{"type":"chat","confidence":0.8}\n```')]);
    const msg = textMessage('user', 'hi');
    const result = await classifyByLlm(msg, [], llm, 'gpt-4o');
    expect(result.type).toBe('chat');
    expect(result.confidence).toBe(0.8);
  });

  it('clamps confidence to [0, 1]', async () => {
    const llm = mockLlm([baseResponse('{"type":"chat","confidence":1.5}')]);
    const msg = textMessage('user', 'hi');
    const result = await classifyByLlm(msg, [], llm, 'gpt-4o');
    expect(result.confidence).toBe(1);
  });

  it('falls back to chat on invalid type', async () => {
    const llm = mockLlm([baseResponse('{"type":"unknown","confidence":0.9}')]);
    const msg = textMessage('user', 'x');
    const result = await classifyByLlm(msg, [], llm, 'gpt-4o');
    expect(result.type).toBe('chat');
    expect(result.confidence).toBeLessThan(0.5);
  });

  it('falls back to chat on non-JSON response', async () => {
    const llm = mockLlm([baseResponse('Sorry, I cannot classify this.')]);
    const msg = textMessage('user', 'x');
    const result = await classifyByLlm(msg, [], llm, 'gpt-4o');
    expect(result.type).toBe('chat');
    expect(result.reason).toMatch(/parse/);
  });

  it('falls back to chat on LLM error', async () => {
    const llm: LlmClient = {
      chat: vi.fn(async () => { throw new Error('network down'); }),
      chatStream: vi.fn(async () => { throw new Error('network down'); }),
      embed: vi.fn(async () => { throw new Error('network down'); }),
    };
    const msg = textMessage('user', 'x');
    const result = await classifyByLlm(msg, [], llm, 'gpt-4o');
    expect(result.type).toBe('chat');
    expect(result.reason).toMatch(/llm call failed/);
  });

  it('includes recent history in LLM context', async () => {
    const llm = mockLlm([baseResponse('{"type":"chat","confidence":0.9}')]);
    const msg = textMessage('user', 'and you?');
    const history = [
      textMessage('user', 'hello'),
      textMessage('assistant', 'hi there'),
    ];
    await classifyByLlm(msg, history, llm, 'gpt-4o');
    expect(llm.chat).toHaveBeenCalledTimes(1);
    interface MockReq { messages: { role: string; content: string }[] }
    const calls = (llm.chat as unknown as { mock: { calls: MockReq[][] } }).mock.calls;
    const callArg = calls[0]![0]!;
    // system + 2 history + 1 user = 4 messages
    expect(callArg.messages).toHaveLength(4);
    expect(callArg.messages[1]!.content).toBe('hello');
    expect(callArg.messages[2]!.content).toBe('hi there');
  });
});

describe('classify (integration)', () => {
  it('uses rules when confidence >= threshold', async () => {
    const llm = mockLlm([baseResponse('{"type":"chat","confidence":0.9}')]);
    const msg = textMessage('user', '你好');
    const result = await classify(msg, [], { llm, model: 'gpt-4o' });
    expect(result.source).toBe('rules');
    expect(result.type).toBe('chat');
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('falls back to LLM when rules confidence < threshold', async () => {
    const llm = mockLlm([baseResponse('{"type":"problem","confidence":0.85,"reason":"task"}')]);
    // Pure question: rules return chat@0.7; with threshold 0.75, 0.7 < 0.75 → LLM
    const msg = textMessage('user', '为什么天空是蓝色的？');
    const result = await classify(msg, [], { llm, model: 'gpt-4o', rulesConfidenceThreshold: 0.75 });
    expect(result.source).toBe('llm');
    expect(result.type).toBe('problem');
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it('falls back to LLM when rules return null', async () => {
    const llm = mockLlm([baseResponse('{"type":"chat","confidence":0.7}')]);
    const msg = textMessage('user', 'the weather is nice today');
    const result = await classify(msg, [], { llm, model: 'gpt-4o' });
    expect(result.source).toBe('llm');
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it('respects custom rulesConfidenceThreshold', async () => {
    const llm = mockLlm([baseResponse('{"type":"chat","confidence":0.9}')]);
    // "你好" matches greeting rule with confidence 0.9
    // With threshold 0.95, rules result (0.9) < 0.95 → LLM
    const msg = textMessage('user', '你好');
    const result = await classify(msg, [], { llm, model: 'gpt-4o', rulesConfidenceThreshold: 0.95 });
    expect(result.source).toBe('llm');
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });
});
