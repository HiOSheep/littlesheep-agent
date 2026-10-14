// Wire-shape tests for the Anthropic Messages protocol.
//
// The shared conformance suite (`client-conformance.test.ts`) asserts what every
// protocol must do the same way. This file asserts what Anthropic does DIFFERENTLY,
// because those quirks are where a client silently sends a request the vendor
// rejects:
//   - `system` is a top-level field, not a message with role 'system';
//   - tool results for one assistant turn must be merged into a single user message;
//   - `input_schema` (not `parameters`), and `tool_use.input` must be a JSON object;
//   - `max_tokens` is required and must exceed `budget_tokens`.
//
// Each of these was a documented rejection reason, so each gets an explicit test
// rather than being left to the happy-path check.

import { describe, expect, it } from 'vitest'
// The request/response translation lives in its own module so the client file stays
// the stream-driving half of the protocol.
import { buildAnthropicMessagesBody } from './anthropic-translate.js'
import type { ChatRequest } from './types.js'
import { PROTOCOL_DESCRIPTORS, protocolHeaders, protocolUrl } from './protocols.js'

const DESCRIPTOR = PROTOCOL_DESCRIPTORS['anthropic-messages']

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'claude-fixture',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  }
}

describe('anthropic messages request translation', () => {
  it('sends system prompts top-level instead of as a message role', () => {
    const body = buildAnthropicMessagesBody(request({
      messages: [
        { role: 'system', content: 'You are a fixture.' },
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'hello' },
      ],
    }), false)

    expect(body.system).toBe('You are a fixture.\n\nBe terse.')
    // The vendor rejects `role: 'system'` inside `messages`, so its absence is the assertion.
    expect(body.messages.map((message) => message.role)).toEqual(['user'])
    expect(JSON.stringify(body.messages)).not.toContain('fixture.')
  })

  it('always sends max_tokens, which the vendor requires', () => {
    expect(buildAnthropicMessagesBody(request(), false).max_tokens).toBeGreaterThan(0)
    // An explicit caller value wins.
    expect(buildAnthropicMessagesBody(request({ max_tokens: 1234 }), false).max_tokens).toBe(1234)
  })

  it('keeps the thinking budget strictly below max_tokens', () => {
    // Anthropic rejects `budget_tokens >= max_tokens`, so a caller asking for a small
    // budget alongside a thinking effort must still get a valid request.
    const body = buildAnthropicMessagesBody(request({
      max_tokens: 500,
      reasoning_effort: 'high',
    }), false)
    expect(body.thinking).toBeDefined()
    const thinking = body.thinking as { type: string; budget_tokens?: number }
    expect(thinking.type).toBe('enabled')
    expect(thinking.budget_tokens).toBeGreaterThan(0)
    expect(body.max_tokens).toBeGreaterThan(thinking.budget_tokens!)
  })

  it('does not enable thinking for an effort that means "do not think"', () => {
    for (const reasoning_effort of ['none', 'minimal'] as const) {
      const body = buildAnthropicMessagesBody(request({ reasoning_effort }), false)
      const thinking = body.thinking as { type?: string } | undefined
      expect(thinking?.type === 'enabled', `${reasoning_effort} must not enable thinking`).toBe(false)
    }
    expect(buildAnthropicMessagesBody(request({ reasoning_effort: 'high' }), false).thinking)
      .toMatchObject({ type: 'enabled' })
  })

  it('translates tools to input_schema and named tool_choice to a tool entry', () => {
    const body = buildAnthropicMessagesBody(request({
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      }],
      tool_choice: { type: 'function', function: { name: 'read_file' } },
    }), false)

    // `parameters` is the OpenAI name; sending it to Anthropic is a 400.
    expect(body.tools).toEqual([{
      name: 'read_file',
      description: 'Read a file',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    }])
    expect(JSON.stringify(body.tools)).not.toContain('"parameters"')
    expect(body.tool_choice).toMatchObject({ type: 'tool', name: 'read_file' })
  })

  it('drops tools entirely for tool_choice none rather than sending a none entry', () => {
    const body = buildAnthropicMessagesBody(request({
      tools: [{ type: 'function', function: { name: 'read_file', description: 'x', parameters: {} } }],
      tool_choice: 'none',
    }), false)
    expect(body.tool_choice).toBeUndefined()
    expect(JSON.stringify(body.tool_choice ?? null)).not.toContain('none')
  })

  it('translates assistant tool calls to tool_use blocks with an object input', () => {
    const body = buildAnthropicMessagesBody(request({
      messages: [
        { role: 'user', content: 'read it' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
          }],
        },
      ],
    }), false)

    const assistant = body.messages.find((message) => message.role === 'assistant')!
    const toolUse = assistant.content.find((block) => block.type === 'tool_use') as {
      id: string
      name: string
      input: unknown
    }
    expect(toolUse.id).toBe('call_1')
    expect(toolUse.name).toBe('read_file')
    // `input` must be an OBJECT; Anthropic rejects a JSON string here.
    expect(typeof toolUse.input).toBe('object')
    expect(toolUse.input).toEqual({ path: 'a.txt' })
  })

  it('survives unparsable tool arguments instead of sending an invalid input', () => {
    const body = buildAnthropicMessagesBody(request({
      messages: [
        { role: 'user', content: 'read it' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{not json' } }],
        },
      ],
    }), false)
    const assistant = body.messages.find((message) => message.role === 'assistant')!
    const toolUse = assistant.content.find((block) => block.type === 'tool_use') as { input: unknown }
    expect(typeof toolUse.input).toBe('object')
    expect(toolUse.input).toEqual({})
  })

  it('merges the tool results of one turn into a single user message', () => {
    // Anthropic requires every tool_result for an assistant turn to arrive in ONE user
    // message; two consecutive tool messages are a 400.
    const body = buildAnthropicMessagesBody(request({
      messages: [
        { role: 'user', content: 'read both' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
            { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'contents of a' },
        { role: 'tool', tool_call_id: 'call_2', content: 'contents of b' },
      ],
    }), false)

    const userMessages = body.messages.filter((message) => message.role === 'user')
    // The opening user turn, then exactly one message carrying both results.
    expect(userMessages).toHaveLength(2)
    const results = userMessages[1]!.content.filter((block) => block.type === 'tool_result')
    expect(results.map((block) => (block as { tool_use_id: string }).tool_use_id)).toEqual(['call_1', 'call_2'])
  })

  it('renders a plain string user turn as a text block', () => {
    const body = buildAnthropicMessagesBody(request(), false)
    expect(body.messages[0]!.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('sends the stream flag the caller asked for', () => {
    expect(buildAnthropicMessagesBody(request(), true).stream).toBe(true)
    expect(buildAnthropicMessagesBody(request(), false).stream).toBe(false)
  })
})

describe('anthropic transport facts', () => {
  it('posts to /messages with an x-api-key credential and the required version header', () => {
    expect(protocolUrl('https://api.anthropic.com/v1', DESCRIPTOR.path))
      .toBe('https://api.anthropic.com/v1/messages')
    const headers = protocolHeaders(DESCRIPTOR, 'sk-ant-fixture')
    // Anthropic authenticates by header, NOT by bearer token: sending Authorization
    // instead produces a 401 that reads like a bad key.
    expect(headers['x-api-key']).toBe('sk-ant-fixture')
    expect(headers.Authorization).toBeUndefined()
    // Requests without this are rejected outright.
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('does not double the path when the base URL already ends with it', () => {
    expect(protocolUrl('https://gw.example.test/v1/messages', DESCRIPTOR.path))
      .toBe('https://gw.example.test/v1/messages')
  })

  it('keeps configured gateway headers alongside the protocol ones', () => {
    const headers = protocolHeaders(DESCRIPTOR, 'sk-ant-fixture', { 'x-gateway-route': 'pool-a' })
    expect(headers['x-gateway-route']).toBe('pool-a')
    expect(headers['x-api-key']).toBe('sk-ant-fixture')
  })
})
