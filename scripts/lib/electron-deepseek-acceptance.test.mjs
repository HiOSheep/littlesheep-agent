import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSse } from './electron-deepseek-acceptance.mjs'

function streamResponse(events) {
  const body = events.map(({ name, data }) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

describe('Electron acceptance SSE result replay', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('loads an oversized completed result through its run reference', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse([
        { name: 'start', data: { runId: 'run-large' } },
        { name: 'result_ref', data: { runId: 'run-large' } },
      ]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ runId: 'run-large', status: 'ok', reply: 'done' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await readSse({ host: '127.0.0.1', port: 43127 }, '/run/stream', { text: 'finish' })

    expect(result.result).toMatchObject({ runId: 'run-large', status: 'ok', reply: 'done' })
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://127.0.0.1:43127/runs/run-large')
  })

  it('rejects a result reference that differs from start metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(streamResponse([
      { name: 'start', data: { runId: 'run-start' } },
      { name: 'result_ref', data: { runId: 'run-other' } },
    ]))
    vi.stubGlobal('fetch', fetchMock)

    await expect(readSse({ host: '127.0.0.1', port: 43127 }, '/run/stream', { text: 'finish' }))
      .rejects.toThrow('result reference does not match start metadata')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
