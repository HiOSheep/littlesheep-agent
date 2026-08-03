import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { startDelayedHttpProxy } from './delayed-http-proxy.mjs'

const cleanup = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()()
})

describe('delayed HTTP acceptance proxy', () => {
  it('forwards bounded request metadata and records Provider usage', async () => {
    const upstreamRequests = []
    const upstream = await startServer(async (req, res) => {
      const body = await readBody(req)
      upstreamRequests.push({
        path: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(body),
      })
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      }))
    })
    const proxy = await startDelayedHttpProxy({ upstreamBaseURL: `${upstream.baseURL}/v1`, delayMs: 5 })
    cleanup.push(proxy.close, upstream.close)

    const response = await fetch(`${proxy.baseURL}/chat/completions?acceptance=1`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'test-model', stream: false, messages: [] }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ usage: { total_tokens: 15 } })
    expect(upstreamRequests).toEqual([{
      path: '/v1/chat/completions?acceptance=1',
      authorization: 'Bearer test-key',
      body: { model: 'test-model', stream: false, messages: [] },
    }])
    expect(proxy.requests).toMatchObject([{
      model: 'test-model',
      stream: false,
      forwarded: true,
      aborted: false,
      status: 200,
      usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
    }])
  })

  it('does not call the upstream when the client disconnects during the delay', async () => {
    let upstreamCalls = 0
    const upstream = await startServer((_req, res) => {
      upstreamCalls += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
    const proxy = await startDelayedHttpProxy({ upstreamBaseURL: upstream.baseURL, delayMs: 250 })
    cleanup.push(proxy.close, upstream.close)
    const controller = new AbortController()
    const pending = fetch(`${proxy.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'aborted-model' }),
      signal: controller.signal,
    })
    await waitFor(() => proxy.requests.length === 1)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(upstreamCalls).toBe(0)
    expect(proxy.requests).toMatchObject([{
      model: 'aborted-model',
      forwarded: false,
      aborted: true,
    }])
  })

  it('records authoritative usage from the final streaming event', async () => {
    const upstream = await startServer(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
      res.write('data: {"choices":[],"usage":{"prompt_tokens":21,"completion_tokens":4,"total_tokens":25}}\n\n')
      res.end('data: [DONE]\n\n')
    })
    const proxy = await startDelayedHttpProxy({ upstreamBaseURL: upstream.baseURL, delayMs: 0 })
    cleanup.push(proxy.close, upstream.close)

    const response = await fetch(`${proxy.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'stream-model', stream: true, messages: [] }),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('data: [DONE]')
    expect(proxy.requests).toMatchObject([{
      model: 'stream-model',
      stream: true,
      usage: { promptTokens: 21, completionTokens: 4, totalTokens: 25 },
    }])
  })

  it('injects a bounded one-shot disconnect without reaching the upstream', async () => {
    let upstreamCalls = 0
    const upstream = await startServer(async (_req, res) => {
      upstreamCalls += 1
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'recovered' } }] }))
    })
    const proxy = await startDelayedHttpProxy({ upstreamBaseURL: upstream.baseURL, delayMs: 0 })
    cleanup.push(proxy.close, upstream.close)

    expect(proxy.disconnectNext()).toBe(1)
    await expect(fetch(`${proxy.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'recovery-model', stream: false, messages: [] }),
    })).rejects.toBeInstanceOf(TypeError)

    expect(proxy.pendingFaultCount()).toBe(0)
    expect(upstreamCalls).toBe(0)
    expect(proxy.requests).toMatchObject([{
      model: 'recovery-model',
      forwarded: false,
      aborted: false,
      injectedFault: 'disconnect',
    }])

    const recovered = await fetch(`${proxy.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'recovery-model', stream: false, messages: [] }),
    })
    expect(recovered.status).toBe(200)
    expect(upstreamCalls).toBe(1)
    expect(proxy.requests[1]).toMatchObject({ forwarded: true, status: 200 })
  })

  it('rejects unbounded fault queues', async () => {
    const upstream = await startServer((_req, res) => res.end('{}'))
    const proxy = await startDelayedHttpProxy({ upstreamBaseURL: upstream.baseURL, delayMs: 0 })
    cleanup.push(proxy.close, upstream.close)

    expect(() => proxy.disconnectNext(0)).toThrow(/between 1 and 8/u)
    expect(() => proxy.disconnectNext(9)).toThrow(/between 1 and 8/u)
    expect(proxy.disconnectNext(4)).toBe(4)
    expect(proxy.disconnectNext(4)).toBe(8)
    expect(() => proxy.disconnectNext()).toThrow(/at most 8 faults may be pending/u)
  })
})

async function startServer(handler) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(error instanceof Error ? error.message : String(error))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolveClose) => server.close(() => resolveClose()))
    },
  }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for proxy request')
}
