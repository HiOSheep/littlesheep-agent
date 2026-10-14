// Wire-shape tests for the OpenAI Responses protocol.
//
// The shared conformance suite asserts what every protocol must do the same way.
// This file asserts what Responses does DIFFERENTLY, because those are the places a
// client silently sends something the endpoint never implements:
//   - the body uses `input` items, not `messages`;
//   - the token cap is `max_output_tokens`, not `max_tokens`;
//   - an assistant turn's tool calls become SEPARATE `function_call` items;
//   - a tool result is a `function_call_output` item keyed by `call_id`;
//   - streaming is a typed event stream whose function-call identity and arguments
//     arrive in different events.

import { describe, expect, it } from 'vitest'
import {
  buildResponsesInputItems,
  buildResponsesRequestBody,
  buildResponsesToolChoice,
  buildResponsesTools,
  finishReasonOf,
  parseResponsesOutput,
  parseResponsesUsage,
  responsesErrorMessage,
  statusField,
} from './responses-translate.js'
import { OpenAIResponsesClient } from './responses-client.js'
import type { ChatRequest, StreamChunk } from './types.js'
import { PROTOCOL_DESCRIPTORS, protocolUrl } from './protocols.js'

const DESCRIPTOR = PROTOCOL_DESCRIPTORS['openai-responses']

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'gpt-fixture',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  }
}

describe('responses request translation', () => {
  it('sends input items instead of a messages array', () => {
    const body = buildResponsesRequestBody(request({
      messages: [
        { role: 'system', content: 'You are a fixture.' },
        { role: 'user', content: 'hello' },
      ],
    }), false)

    // `messages` is the chat-completions name; Responses rejects it.
    expect(body).not.toHaveProperty('messages')
    expect(Array.isArray(body.input)).toBe(true)
    const items = body.input as { role: string; content: { type: string; text: string }[] }[]
    expect(items.map((item) => item.role)).toEqual(['system', 'user'])
    expect(items[0]!.content[0]!.type).toBe('input_text')
  })

  it('uses max_output_tokens rather than max_tokens', () => {
    const body = buildResponsesRequestBody(request({ max_tokens: 777 }), false)
    expect(body.max_output_tokens).toBe(777)
    expect(body).not.toHaveProperty('max_tokens')
  })

  it('turns assistant tool calls into separate function_call items', () => {
    const items = buildResponsesInputItems([
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: 'on it',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'contents' },
    ])

    const call = items.find((item) => item.type === 'function_call') as {
      call_id: string
      name: string
      arguments: string
    }
    expect(call.call_id).toBe('call_1')
    expect(call.name).toBe('read_file')
    // Arguments stay a JSON STRING in this protocol, unlike Anthropic's object input.
    expect(typeof call.arguments).toBe('string')

    const output = items.find((item) => item.type === 'function_call_output') as {
      call_id: string
      output: string
    }
    expect(output.call_id).toBe('call_1')
    expect(output.output).toBe('contents')
  })

  it('keeps tool schemas under parameters and names a forced tool', () => {
    const tools = buildResponsesTools([{
      type: 'function',
      function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } },
    }])
    expect(tools[0]).toMatchObject({ type: 'function', name: 'read_file', parameters: { type: 'object' } })
    expect(buildResponsesToolChoice({ type: 'function', function: { name: 'read_file' } }))
      .toMatchObject({ type: 'function', name: 'read_file' })
    expect(buildResponsesToolChoice('auto')).toBe('auto')
  })
})

describe('responses response reading', () => {
  it('reads text, function calls and usage out of the output items', () => {
    const response = parseResponsesOutput({
      id: 'resp_1',
      model: 'gpt-fixture',
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'the answer' }] },
        { type: 'function_call', call_id: 'call_9', name: 'glob', arguments: '{"pattern":"**"}' },
      ],
      usage: {
        input_tokens: 30,
        output_tokens: 7,
        total_tokens: 37,
        input_tokens_details: { cached_tokens: 12 },
      },
    })

    expect(response.content).toBe('the answer')
    expect(response.reasoningContent).toBe('thought')
    expect(response.toolCalls).toEqual([{
      id: 'call_9',
      type: 'function',
      function: { name: 'glob', arguments: '{"pattern":"**"}' },
    }])
    // Any function call makes this a tool turn regardless of status.
    expect(response.finishReason).toBe('tool_calls')
    expect(response.usage).toMatchObject({ promptTokens: 30, completionTokens: 7, cachedPromptTokens: 12 })
  })

  it('reports a truncated answer as a length finish', () => {
    expect(finishReasonOf(true, false)).toBe('length')
    expect(finishReasonOf(false, false)).toBe('stop')
    expect(finishReasonOf(false, true)).toBe('tool_calls')
  })

  it('reads the cache counter as a subset of the input, never above it', () => {
    expect(parseResponsesUsage({ input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 4 } }))
      .toMatchObject({ promptTokens: 10, cachedPromptTokens: 4 })
    // A nonsensical cache count above the prompt is dropped rather than reported.
    expect(parseResponsesUsage({ input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 99 } }))
      .toMatchObject({ promptTokens: 10 })
    expect(parseResponsesUsage({ input_tokens: 10, output_tokens: 1 })?.cachedPromptTokens).toBeUndefined()
  })

  it('coerces a numeric-string status code, which providers really do send', () => {
    // `{"code":"429"}` is as common as `{"code":429}`; treating the string as absent
    // silently downgrades a rate limit to a generic failure.
    expect(statusField({ code: '429' }, 'code')).toBe(429)
    expect(statusField({ code: 429 }, 'code')).toBe(429)
    expect(statusField({ code: 'nonsense' }, 'code')).toBeUndefined()
    expect(statusField({}, 'code')).toBeUndefined()
  })

  it('reads the provider message from the Responses error envelope', () => {
    expect(responsesErrorMessage({ error: { message: 'bad request', type: 'invalid_request_error' } }))
      .toBe('bad request')
    expect(responsesErrorMessage({ error: { type: 'x' } })).toBeUndefined()
  })
})

describe('responses transport facts', () => {
  it('posts to /responses', () => {
    expect(protocolUrl('https://api.openai.com/v1', DESCRIPTOR.path))
      .toBe('https://api.openai.com/v1/responses')
  })
})

/**
 * One streamed turn with a function call, driven through the real client.
 *
 * This is the case that broke twice: identity (`call_id`/`name`) arrives on
 * `output_item.added` while the arguments arrive as
 * `function_call_arguments.delta` keyed by `output_index`. A consumer that binds a
 * tool call on the first delta it sees needs that identity on the delta itself.
 */
function sseFrames(frames: string[]): typeof fetch {
  const encoded = frames.map((frame) => new TextEncoder().encode(`${frame}\n\n`))
  return (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({}),
    body: {
      [Symbol.asyncIterator]() {
        let index = 0
        return {
          next: async () => (index < encoded.length
            ? { done: false, value: encoded[index++] }
            : { done: true, value: undefined }),
        }
      },
    },
  })) as unknown as typeof fetch
}

describe('responses streaming tool-call identity', () => {
  it('republishes call identity on the argument deltas that follow it', async () => {
    const client = new OpenAIResponsesClient({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-fixture',
      fetch: sseFrames([
        'data: {"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","call_id":"call_a","name":"read_file","arguments":""}}',
        'data: {"type":"response.function_call_arguments.delta","output_index":2,"delta":"{\\"p\\""}',
        'data: {"type":"response.function_call_arguments.delta","output_index":2,"delta":":1}"}',
        'data: {"type":"response.completed","response":{"status":"completed"}}',
      ]),
    })

    const chunks: StreamChunk[] = []
    const response = await client.chatStream(request(), (chunk) => chunks.push(chunk))
    const deltas = chunks.filter((chunk) => chunk.type === 'tool_call_delta')

    expect(deltas.map((chunk) => chunk.toolCallIndex)).toEqual([2, 2, 2])
    // Identity on EVERY delta, not only the first: arguments a consumer cannot bind
    // to a call are arguments it has to drop.
    for (const delta of deltas) {
      expect(delta.toolCallId).toBe('call_a')
      expect(delta.toolCallName).toBe('read_file')
    }
    expect(response.toolCalls).toEqual([{
      id: 'call_a',
      type: 'function',
      function: { name: 'read_file', arguments: '{"p":1}' },
    }])
  })

  it('leaves identity absent rather than empty when the provider never supplies it', async () => {
    const client = new OpenAIResponsesClient({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-fixture',
      fetch: sseFrames([
        'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{}"}',
        'data: {"type":"response.completed","response":{"status":"completed"}}',
      ]),
    })
    const chunks: StreamChunk[] = []
    await client.chatStream(request(), (chunk) => chunks.push(chunk))
    const first = chunks.find((chunk) => chunk.type === 'tool_call_delta')!
    // An empty string would be a lie the consumer cannot tell from a real id.
    expect(first.toolCallId).toBeUndefined()
    expect(first.toolCallName).toBeUndefined()
  })
})
