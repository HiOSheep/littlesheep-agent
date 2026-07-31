import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  OpenAIClient,
  buildOpenAICompatibleChatCompletionsBody,
  createLlmClient,
} from './client.js';
import { LlmError, type ChatResponse } from './types.js';
import { zodToJsonSchema, buildToolSpec } from './schema.js';
import { retryWithBackoff } from './retry.js';

/** Build a mock fetch that returns given responses in sequence. */
function mockFetch(responses: Array<{ status?: number; json?: unknown; body?: string; text?: string }>) {
  let call = 0;
  const fn = vi.fn(async () => {
    const r = responses[Math.min(call, responses.length - 1)]!;
    call++;
    const status = r.status ?? 200;
    const headers = new Map<string, string>();
    if (r.body !== undefined) headers.set('content-type', 'text/event-stream');
    else headers.set('content-type', 'application/json');
    const body = r.body ?? JSON.stringify(r.json ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headers.get(k.toLowerCase()) },
      json: async () => r.json ?? {},
      text: async () => r.text ?? body,
      body: r.body !== undefined ? new MockBody(r.body) : null,
    } as unknown as Response;
  });
  return fn;
}

/** Mock ReadableStream for SSE testing. */
class MockBody {
  private chunks: Uint8Array[];
  constructor(sseText: string) {
    this.chunks = sseText.split('\n\n').map((part) => new TextEncoder().encode(part + '\n\n'));
  }
  getReader() {
    let i = 0;
    return {
      read: async () => {
        if (i < this.chunks.length) return { done: false, value: this.chunks[i++]! };
        return { done: true, value: undefined };
      },
    };
  }
}

const BASE_OPTS = {
  baseURL: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  timeoutMs: 5000,
};

describe('OpenAI-compatible request body', () => {
  it('matches the payload shape used by runtime chat calls', () => {
    expect(buildOpenAICompatibleChatCompletionsBody({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 100,
      reasoning_effort: 'high',
      thinking: { type: 'enabled' },
    }, true, { includeStreamUsage: true })).toEqual({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 100,
      reasoning_effort: 'high',
      thinking: { type: 'enabled' },
    });
  });
});

describe('OpenAIClient.chat', () => {
  it('parses a simple text response', async () => {
    const fetch = mockFetch([{
      json: {
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Hello there' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    }]);
    const client = new OpenAIClient({ ...BASE_OPTS, fetch });
    const res = await client.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('Hello there');
    expect(res.toolCalls).toHaveLength(0);
    expect(res.finishReason).toBe('stop');
    expect(res.usage?.promptTokens).toBe(10);
    expect(res.model).toBe('gpt-4o');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('releases the caller abort listener after the response is consumed', async () => {
    const fetch = mockFetch([{
      json: {
        id: 'chatcmpl-lifecycle',
        model: 'gpt-4o',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
      },
    }]);
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const client = new OpenAIClient({ ...BASE_OPTS, fetch });

    await client.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    });

    expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('parses tool_calls response', async () => {
    const fetch = mockFetch([{
      json: {
        id: 'chatcmpl-2',
        model: 'gpt-4o',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_abc',
              type: 'function',
              function: { name: 'read', arguments: '{"file_path":"/tmp/x"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      },
    }]);
    const client = new OpenAIClient({ ...BASE_OPTS, fetch });
    const res = await client.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'read /tmp/x' }],
    });
    expect(res.content).toBe('');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]?.id).toBe('call_abc');
    expect(res.toolCalls[0]?.function.name).toBe('read');
    expect(res.toolCalls[0]?.function.arguments).toBe('{"file_path":"/tmp/x"}');
    expect(res.finishReason).toBe('tool_calls');
  });

  it('parses provider reasoning and detailed usage without mixing it into visible content', async () => {
    const fetch = mockFetch([{
      json: {
        id: 'chatcmpl-reasoning',
        model: 'deepseek-v4-pro',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'final',
            reasoning_content: 'private provider reasoning',
          },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 12,
          total_tokens: 32,
          prompt_cache_hit_tokens: 5,
          completion_tokens_details: { reasoning_tokens: 8 },
        },
      },
    }]);
    const client = new OpenAIClient({ ...BASE_OPTS, fetch });

    const res = await client.chat({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'think' }],
    });

    expect(res.content).toBe('final');
    expect(res.reasoningContent).toBe('private provider reasoning');
    expect(res.usage).toEqual({
      promptTokens: 20,
      completionTokens: 12,
      totalTokens: 32,
      cachedPromptTokens: 5,
      reasoningTokens: 8,
    });
  });

  it('retries on 503 then succeeds', async () => {
    const fetch = mockFetch([
      { status: 503, json: { error: { message: 'Service Unavailable' } } },
      {
        json: {
          id: 'chatcmpl-3', model: 'gpt-4o',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        },
      },
    ]);
    const client = new OpenAIClient({
      ...BASE_OPTS, fetch,
      retry: { maxAttempts: 3, baseDelayMs: 1, jitter: false },
    });
    const res = await client.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('ok');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('throws LlmError on 400 (non-retryable)', async () => {
    const fetch = mockFetch([
      { status: 400, json: { error: { message: 'Bad request' } } },
    ]);
    const client = new OpenAIClient({
      ...BASE_OPTS, fetch,
      retry: { maxAttempts: 3, baseDelayMs: 1, jitter: false },
    });
    await expect(client.chat({ model: 'gpt-4o', messages: [] })).rejects.toThrow(LlmError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('sends tools and tool_choice in body', async () => {
    const fetch = mockFetch([{
      json: {
        id: 'x', model: 'gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
      },
    }]);
    const client = new OpenAIClient({ ...BASE_OPTS, fetch });
    await client.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'go' }],
      tools: [buildToolSpec('read', 'Read a file', z.object({ file_path: z.string() }))],
      tool_choice: 'auto',
      temperature: 0.5,
      max_tokens: 100,
    });
    const callBody = JSON.parse((fetch.mock.calls[0]![1] as { body: string }).body);
    expect(callBody.tools).toHaveLength(1);
    expect(callBody.tools[0].function.name).toBe('read');
    expect(callBody.tool_choice).toBe('auto');
    expect(callBody.temperature).toBe(0.5);
    expect(callBody.max_tokens).toBe(100);
  });

  it('sends provider reasoning controls and preserved reasoning messages', async () => {
    const fetch = mockFetch([{
      json: {
        id: 'x', model: 'glm-5.2',
        choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
      },
    }]);
    const client = new OpenAIClient({ ...BASE_OPTS, fetch });
    await client.chat({
      model: 'glm-5.2',
      messages: [{
        role: 'assistant',
        content: '',
        reasoning_content: 'preserve exactly',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'read', arguments: '{}' },
        }],
      }],
      reasoning_effort: 'max',
      thinking: { type: 'enabled', clear_thinking: false },
    });
    const callBody = JSON.parse((fetch.mock.calls[0]![1] as { body: string }).body);
    expect(callBody.reasoning_effort).toBe('max');
    expect(callBody.thinking).toEqual({ type: 'enabled', clear_thinking: false });
    expect(callBody.messages[0].reasoning_content).toBe('preserve exactly');
  });

  it('sends multimodal content parts in the request body', async () => {
    const fetch = mockFetch([{
      json: {
        id: 'x', model: 'gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: 'seen' }, finish_reason: 'stop' }],
      },
    }]);
    const client = new OpenAIClient({ ...BASE_OPTS, fetch });
    await client.chat({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'auto' } },
        ],
      }],
    });
    const callBody = JSON.parse((fetch.mock.calls[0]![1] as { body: string }).body);
    expect(callBody.messages[0].content).toEqual([
      { type: 'text', text: 'describe this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'auto' } },
    ]);
  });

  it('includes Authorization header when apiKey set', async () => {
    const fetch = mockFetch([{
      json: { id: 'x', model: 'gpt-4o', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] },
    }]);
    const client = new OpenAIClient({ ...BASE_OPTS, fetch });
    await client.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    const headers = (fetch.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['Content-Type']).toBe('application/json');
  });
});

describe('OpenAIClient.chatStream', () => {
  it('parses SSE text deltas', async () => {
    const sse = [
      'data: {"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}]}',
      'data: {"model":"gpt-4o","choices":[{"index":0,"delta":{"content":" world"}}]}',
      'data: {"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: {"model":"gpt-4o","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}',
      'data: [DONE]',
    ].join('\n\n');
    const fetch = mockFetch([{ body: sse }]);
    const client = new OpenAIClient({ ...BASE_OPTS, fetch });
    const deltas: string[] = [];
    const res = await client.chatStream(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      (chunk) => {
        if (chunk.type === 'delta' && chunk.delta) deltas.push(chunk.delta);
      },
    );
    expect(deltas.join('')).toBe('Hello world');
    expect(res.content).toBe('Hello world');
    expect(res.finishReason).toBe('stop');
    expect(res.usage).toEqual({ promptTokens: 12, completionTokens: 3, totalTokens: 15 });
    const body = JSON.parse((fetch.mock.calls[0]![1] as { body: string }).body);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('parses tool_call deltas across chunks', async () => {
    const sse = [
      'data: {"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":""}}]}}]}',
      'data: {"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"file"}}]}}]}',
      'data: {"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"_path\\":\\"/x\\"}"}}]}}]}',
      'data: {"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ].join('\n\n');
    const fetch = mockFetch([{ body: sse }]);
    const client = new OpenAIClient({ ...BASE_OPTS, fetch });
    const res = await client.chatStream(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'read /x' }] },
      () => {},
    );
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]?.id).toBe('call_1');
    expect(res.toolCalls[0]?.function.name).toBe('read');
    expect(res.toolCalls[0]?.function.arguments).toBe('{"file_path":"/x"}');
    expect(res.finishReason).toBe('tool_calls');
  });

  it('aggregates streamed reasoning separately from visible answer deltas', async () => {
    const sse = [
      'data: {"model":"glm-5.2","choices":[{"index":0,"delta":{"reasoning_content":"plan "}}]}',
      'data: {"model":"glm-5.2","choices":[{"index":0,"delta":{"reasoning_content":"step"}}]}',
      'data: {"model":"glm-5.2","choices":[{"index":0,"delta":{"content":"answer"}}]}',
      'data: {"model":"glm-5.2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ].join('\n\n');
    const fetch = mockFetch([{ body: sse }]);
    const client = new OpenAIClient({ ...BASE_OPTS, fetch });
    const chunks: Array<{ type: string; delta?: string }> = [];

    const res = await client.chatStream(
      { model: 'glm-5.2', messages: [{ role: 'user', content: 'think' }] },
      (chunk) => chunks.push(chunk),
    );

    expect(res.content).toBe('answer');
    expect(res.reasoningContent).toBe('plan step');
    expect(chunks.filter((chunk) => chunk.type === 'reasoning_delta')).toEqual([
      { type: 'reasoning_delta', delta: 'plan ' },
      { type: 'reasoning_delta', delta: 'step' },
    ]);
  });
});

describe('zodToJsonSchema', () => {
  it('converts a z.object with mixed types', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().int(),
      active: z.boolean(),
      tags: z.array(z.string()),
      nickname: z.string().optional(),
    });
    const json = zodToJsonSchema(schema) as {
      type: string;
      properties: Record<string, { type?: string; enum?: string[]; items?: object }>;
      required: string[];
    };
    expect(json.type).toBe('object');
    expect(json.properties.name.type).toBe('string');
    expect(json.properties.age.type).toBe('number');
    expect(json.properties.active.type).toBe('boolean');
    expect(json.properties.tags.type).toBe('array');
    expect(json.properties.tags.items).toEqual({ type: 'string' });
    expect(json.properties.nickname.type).toBe('string');
    expect(json.required).toEqual(['name', 'age', 'active', 'tags']);
    expect(json.required).not.toContain('nickname');
  });

  it('converts z.enum', () => {
    const schema = z.enum(['a', 'b', 'c']);
    const json = zodToJsonSchema(schema) as { type: string; enum: string[] };
    expect(json.type).toBe('string');
    expect(json.enum).toEqual(['a', 'b', 'c']);
  });

  it('handles optional with default', () => {
    const schema = z.object({
      x: z.string().default('hi'),
    });
    const json = zodToJsonSchema(schema) as {
      properties: Record<string, { type: string }>;
      required?: string[];
    };
    expect(json.properties.x.type).toBe('string');
    expect(json.required ?? []).not.toContain('x');
  });

  it('keeps discriminated unions rooted at an object for provider tool schemas', () => {
    const schema = z.discriminatedUnion('action', [
      z.object({ action: z.literal('list') }),
      z.object({ action: z.literal('read'), path: z.string() }),
    ]);
    const json = zodToJsonSchema(schema) as {
      type: string;
      anyOf: Array<{ type: string; required: string[] }>;
    };

    expect(json.type).toBe('object');
    expect(json.anyOf).toHaveLength(2);
    expect(json.anyOf.every((option) => option.type === 'object')).toBe(true);
    expect(json.anyOf[0]?.required).toEqual(['action']);
    expect(json.anyOf[1]?.required).toEqual(['action', 'path']);
  });

  it('buildToolSpec produces correct shape', () => {
    const spec = buildToolSpec('test', 'A test tool', z.object({ x: z.number() }));
    expect(spec.type).toBe('function');
    expect(spec.function.name).toBe('test');
    expect(spec.function.description).toBe('A test tool');
    expect((spec.function.parameters as { type: string }).type).toBe('object');
  });
});

describe('retryWithBackoff', () => {
  it('retries retryable errors and succeeds', async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls++;
        if (calls < 3) throw new LlmError(503, 'temp', true);
        return 'ok';
      },
      { maxAttempts: 5, baseDelayMs: 1, jitter: false },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry non-retryable errors', async () => {
    let calls = 0;
    await expect(retryWithBackoff(
      async () => {
        calls++;
        throw new LlmError(400, 'bad', false);
      },
      { maxAttempts: 5, baseDelayMs: 1, jitter: false },
    )).rejects.toThrow(LlmError);
    expect(calls).toBe(1);
  });

  it('throws after max attempts', async () => {
    let calls = 0;
    await expect(retryWithBackoff(
      async () => {
        calls++;
        throw new LlmError(503, 'temp', true);
      },
      { maxAttempts: 2, baseDelayMs: 1, jitter: false },
    )).rejects.toThrow(LlmError);
    expect(calls).toBe(2);
  });

  it('respects abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(retryWithBackoff(
      async () => 'ok',
      { maxAttempts: 3, baseDelayMs: 1 },
      controller.signal,
    )).rejects.toThrow(/Aborted/);
  });
});

describe('createLlmClient', () => {
  it('builds client from provider config', async () => {
    const fetch = mockFetch([{
      json: { id: 'x', model: 'gpt-4o', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] },
    }]);
    const client = createLlmClient(
      { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-test', timeoutSeconds: 10 },
      { fetch },
    );
    const res = await client.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('ok');
  });
});
