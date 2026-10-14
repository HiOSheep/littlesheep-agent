// The contract every `LlmClient` implementation must satisfy, asserted once.
//
// Three wire protocols now live behind one neutral interface, and the harness cannot
// tell which one a provider speaks. That makes the interface itself the thing under
// test: a client that gets its own vendor's wire format right but returns a
// `ChatResponse` the harness does not expect is still broken, and per-vendor tests
// written by each implementation's author would not catch it.
//
// So this file drives every registered protocol through the SAME fake transport and
// asserts the SAME neutral outcomes. Adding a protocol means adding one entry to
// `CLIENTS` below; if the client cannot satisfy the contract, that shows up here
// rather than at run time inside a user's task.
//
// What is deliberately NOT asserted here: the vendor-shaped request body and stream
// events. Those are each protocol's own business and are covered by that client's
// own test file, because a shared suite cannot know whether Anthropic wants
// `input_schema` or OpenAI wants `parameters`.

import { describe, expect, it, vi } from 'vitest'
import { OpenAIClient } from './client.js'
import { AnthropicMessagesClient } from './anthropic-client.js'
import { OpenAIResponsesClient } from './responses-client.js'
import type { ChatRequest, LlmClient, StreamChunk } from './types.js'
import { IMPLEMENTED_API_PROTOCOLS, isImplementedApiProtocol } from './protocols.js'
import { PROVIDER_API_PROTOCOLS } from '@littlesheep/config'

/** One protocol's client factory, plus the body its happy-path response must supply. */
interface ClientUnderTest {
  protocol: string
  /** Response body for a successful non-streaming call that answers with text. */
  textResponse: string
  create: (fetchImpl: typeof fetch) => LlmClient
}

const BASE_URL = 'https://fixture.example.test/v1'

/**
 * The shared request every client is driven with. It exercises the parts of the
 * neutral contract that all three protocols must translate: text, a tool spec, a
 * token cap and a timeout.
 */
function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'fixture-model',
    messages: [
      { role: 'system', content: 'You are a fixture.' },
      { role: 'user', content: 'Reply with the single word OK.' },
    ],
    max_tokens: 256,
    ...overrides,
  }
}

/** A fetch that answers every request with the same body and records the calls. */
function recordingFetch(body: unknown, init: { status?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string | URL, options?: RequestInit) => {
    calls.push({ url: String(url), init: options ?? {} })
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const CLIENTS: ClientUnderTest[] = [
  {
    protocol: 'openai-chat-completions',
    textResponse: JSON.stringify({
      id: 'chatcmpl-fixture',
      model: 'fixture-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
    }),
    create: (fetchImpl) => new OpenAIClient({ baseURL: BASE_URL, apiKey: 'fixture-key', fetch: fetchImpl, retry: { maxAttempts: 1 } }),
  },
  {
    protocol: 'anthropic-messages',
    textResponse: JSON.stringify({
      id: 'msg_fixture',
      model: 'fixture-model',
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 11, output_tokens: 2 },
    }),
    create: (fetchImpl) => new AnthropicMessagesClient({ baseURL: BASE_URL, apiKey: 'fixture-key', fetch: fetchImpl, retry: { maxAttempts: 1 } }),
  },
  {
    protocol: 'openai-responses',
    textResponse: JSON.stringify({
      id: 'resp_fixture',
      model: 'fixture-model',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
      usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 },
    }),
    create: (fetchImpl) => new OpenAIResponsesClient({ baseURL: BASE_URL, apiKey: 'fixture-key', fetch: fetchImpl, retry: { maxAttempts: 1 } }),
  },
]

describe('LlmClient conformance', () => {
  it('is exercised for every registered protocol', () => {
    // The suite is only meaningful if it covers everything the enum claims to support.
    // A protocol named in `@littlesheep/config` but not driven here is an implementation
    // that ships without a contract check.
    const covered = new Set(CLIENTS.map((entry) => entry.protocol))
    for (const protocol of PROVIDER_API_PROTOCOLS) {
      expect(covered.has(protocol), `${protocol} has no conformance coverage`).toBe(true)
    }
    // And the reverse: the two package-local lists must agree, since `llm` cannot import
    // `config` (the dependency runs the other way).
    expect([...IMPLEMENTED_API_PROTOCOLS].sort()).toEqual([...PROVIDER_API_PROTOCOLS].sort())
  })

  it('recognises exactly the implemented protocols', () => {
    for (const protocol of IMPLEMENTED_API_PROTOCOLS) expect(isImplementedApiProtocol(protocol)).toBe(true)
    expect(isImplementedApiProtocol('anthropic-messages-v2')).toBe(false)
    expect(isImplementedApiProtocol(undefined)).toBe(false)
  })

  describe.each(CLIENTS)('$protocol', ({ textResponse, create }) => {
    it('answers a plain prompt with text and a stop finish reason', async () => {
      const { impl } = recordingFetch(JSON.parse(textResponse))
      const response = await create(impl).chat(request())
      expect(response.content).toBe('OK')
      expect(response.toolCalls).toEqual([])
      expect(response.finishReason).toBe('stop')
    })

    it('reports prompt and completion tokens', async () => {
      const { impl } = recordingFetch(JSON.parse(textResponse))
      const response = await create(impl).chat(request())
      expect(response.usage?.promptTokens).toBe(11)
      expect(response.usage?.completionTokens).toBe(2)
    })

    it('posts to the provider base URL with the credential and a JSON body', async () => {
      const { impl, calls } = recordingFetch(JSON.parse(textResponse))
      await create(impl).chat(request())
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url.startsWith(BASE_URL)).toBe(true)
      const headers = new Headers(calls[0]!.init.headers as Record<string, string>)
      // The credential may travel as a bearer token or as a vendor header, but it must
      // be present and it must not be in the URL.
      expect(headers.get('authorization') ?? headers.get('x-api-key')).toContain('fixture-key')
      expect(calls[0]!.url).not.toContain('fixture-key')
      expect(headers.get('content-type')).toContain('application/json')
      expect(typeof calls[0]!.init.body).toBe('string')
      // The model reaches the wire. Every protocol names it `model`, so this is neutral.
      expect(JSON.parse(String(calls[0]!.init.body))).toHaveProperty('model', 'fixture-model')
    })

    it('raises a non-retryable LlmError on a client error and keeps the provider message', async () => {
      const impl = (async () => new Response(JSON.stringify({ error: { message: 'fixture rejected the request' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch
      const client = create(impl)
      await expect(client.chat(request())).rejects.toMatchObject({
        name: 'LlmError',
        status: 400,
        retryable: false,
      })
      await expect(client.chat(request())).rejects.toThrow(/fixture rejected the request/)
    })

    it('marks a rate limit retryable and honours the provider wait hint', async () => {
      const impl = (async () => new Response(JSON.stringify({ error: { message: 'slow down' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '2' },
      })) as unknown as typeof fetch
      const error = await create(impl).chat(request()).then(() => null, (caught: unknown) => caught as {
        status: number
        retryable: boolean
        retryAfterMs?: number
      })
      expect(error).not.toBeNull()
      expect(error!.status).toBe(429)
      expect(error!.retryable).toBe(true)
      expect(error!.retryAfterMs).toBe(2000)
    })

    it('calls onProviderResponse once per physical response with its usage', async () => {
      const { impl } = recordingFetch(JSON.parse(textResponse))
      const onProviderResponse = vi.fn()
      await create(impl).chat(request({ onProviderResponse }))
      expect(onProviderResponse).toHaveBeenCalledTimes(1)
      expect(onProviderResponse.mock.calls[0]![0]).toMatchObject({
        attempt: 1,
        completed: true,
        usage: { promptTokens: 11, completionTokens: 2 },
      })
    })

    it('honours an already-aborted signal instead of sending the request', async () => {
      const { impl, calls } = recordingFetch(JSON.parse(textResponse))
      const controller = new AbortController()
      controller.abort()
      await expect(create(impl).chat(request({ signal: controller.signal }))).rejects.toBeTruthy()
      expect(calls).toHaveLength(0)
    })

    it('embeds through the protocol, or refuses with a reason that names the gap', async () => {
      // Not every protocol can embed (Anthropic has no embeddings endpoint at all).
      // Refusing is an acceptable outcome; refusing *silently* or by pretending the
      // call succeeded is not, because the memory/retrieval path depends on it.
      const { impl } = recordingFetch({ data: [{ index: 0, embedding: [0.5, 0.25] }], model: 'fixture-embed', usage: { prompt_tokens: 3 } })
      const outcome = await create(impl).embed({ model: 'fixture-embed', input: 'hello' })
        .then((value) => ({ kind: 'ok' as const, value }), (error: unknown) => ({ kind: 'refused' as const, error }))
      if (outcome.kind === 'ok') {
        expect(outcome.value.embeddings).toEqual([[0.5, 0.25]])
        expect(outcome.value.usage.promptTokens).toBe(3)
        return
      }
      const error = outcome.error as { name?: string; message: string; retryable?: boolean }
      expect(error.name).toBe('LlmError')
      expect(error.message.length).toBeGreaterThan(0)
      expect(error.retryable).toBe(false)
    })
  })
})

describe('streaming conformance', () => {
  it('is exercised for every registered protocol', () => {
    expect(STREAMING_CLIENTS.map((entry) => entry.protocol).sort())
      .toEqual([...PROVIDER_API_PROTOCOLS].sort())
  })

  describe.each(CLIENTS.filter((entry) => STREAMING_CLIENTS.some((streamed) => streamed.protocol === entry.protocol)))('$protocol', ({ protocol, create }) => {
    const streaming = STREAMING_CLIENTS.find((entry) => entry.protocol === protocol)!

    it('streams the answer as deltas and settles on the same text', async () => {
      const impl = streaming.streamFetch()
      const chunks: StreamChunk[] = []
      const response = await create(impl).chatStream(request({ stream: true }), (chunk) => chunks.push(chunk))
      expect(response.content).toBe('OK')
      expect(response.finishReason).toBe('stop')
      // The visible text arrives as deltas, and every delta is a string.
      const text = chunks.filter((chunk) => chunk.type === 'delta').map((chunk) => chunk.delta ?? '').join('')
      expect(text).toBe('OK')
      for (const chunk of chunks) {
        if (chunk.type === 'delta') expect(typeof chunk.delta).toBe('string')
      }
      // A client that owns the retry loop stamps transport identity on its chunks.
      for (const chunk of chunks) expect(chunk.transportAttempt).toBe(1)
      expect(chunks.some((chunk) => chunk.type === 'done')).toBe(true)
    })

    it('reports the settled usage, not a placeholder from the first frame', async () => {
      // A vendor may open a stream with provisional counters and correct them later
      // (Anthropic sends `output_tokens: 1` on `message_start` and the real count on
      // `message_delta`). Reporting the provisional value silently corrupts usage
      // accounting, so the settled number is what every client must return.
      const impl = streaming.streamFetch()
      const response = await create(impl).chatStream(request({ stream: true }), () => {})
      expect(response.usage?.promptTokens).toBe(11)
      expect(response.usage?.completionTokens).toBe(2)
    })

    it('reports usage to the receipt observer for the streamed call', async () => {
      const impl = streaming.streamFetch()
      const onProviderResponse = vi.fn()
      await create(impl).chatStream(request({ stream: true, onProviderResponse }), () => {})
      expect(onProviderResponse).toHaveBeenCalled()
      const last = onProviderResponse.mock.calls.at(-1)![0] as { completed: boolean; usage?: { completionTokens: number } }
      expect(last.completed).toBe(true)
      expect(last.usage?.completionTokens).toBe(2)
    })
  })
})

/**
 * The streamed form of each protocol's happy path, kept next to the non-streaming body
 * above so a reviewer can see both halves of one vendor's shape at once.
 */
const STREAMING_CLIENTS: { protocol: string; streamFetch: () => typeof fetch }[] = [
  {
    protocol: 'openai-chat-completions',
    streamFetch: () => {
      const frames = [
        { id: 'chatcmpl-fixture', model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'O' }, finish_reason: null }] },
        { id: 'chatcmpl-fixture', model: 'fixture-model', choices: [{ index: 0, delta: { content: 'K' }, finish_reason: null }] },
        { id: 'chatcmpl-fixture', model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 2 } },
      ]
      const body = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`
      return (async () => new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })) as unknown as typeof fetch
    },
  },
  {
    // Anthropic streams TYPED events, and its usage is split across two of them: the
    // authoritative output count arrives on `message_delta`, not `message_start`
    // (whose `output_tokens: 1` is a placeholder). A client that reads only
    // `message_start` reports 1 completion token for every streamed call, so the
    // shared assertion below checks the SETTLED numbers rather than the first ones.
    protocol: 'anthropic-messages',
    streamFetch: () => {
      const events: [string, unknown][] = [
        ['message_start', { type: 'message_start', message: { id: 'msg_fixture', model: 'fixture-model', usage: { input_tokens: 11, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'O' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'K' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }],
        ['message_stop', { type: 'message_stop' }],
      ]
      const body = events.map(([name, payload]) => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`).join('')
      return (async () => new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })) as unknown as typeof fetch
    },
  },
  {
    // Responses streams typed events too, with no `[DONE]` sentinel: `response.completed`
    // ends the exchange and carries the settled usage.
    protocol: 'openai-responses',
    streamFetch: () => {
      const frames = [
        { type: 'response.created', response: { id: 'resp_fixture', model: 'fixture-model', status: 'in_progress' } },
        { type: 'response.output_text.delta', output_index: 0, delta: 'O' },
        { type: 'response.output_text.delta', output_index: 0, delta: 'K' },
        {
          type: 'response.completed',
          response: {
            id: 'resp_fixture',
            model: 'fixture-model',
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
            usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 },
          },
        },
      ]
      const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
      return (async () => new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })) as unknown as typeof fetch
    },
  },
]
