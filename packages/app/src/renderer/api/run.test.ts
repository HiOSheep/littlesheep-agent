import { afterEach, describe, expect, it, vi } from 'vitest'

function streamResponse(events: Array<{ name: string; data: unknown }>): Response {
  const body = events
    .map((event) => `event: ${event.name}\ndata: ${JSON.stringify(event.data)}\n\n`)
    .join('')
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

async function loadRunApi() {
  vi.resetModules()
  vi.stubGlobal('window', { littlesheep: { apiBase: 'http://127.0.0.1:43127' } })
  return import('./run.js')
}

describe('renderer run API', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('publishes start metadata before processing run events and returns the matching result', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const api = await loadRunApi()
    fetchMock.mockResolvedValueOnce(streamResponse([
      { name: 'start', data: { ok: true, runId: 'run-1' } },
      { name: 'step_start', data: { type: 'step_start', stepId: 'step-1', title: 'Read' } },
      { name: 'delta', data: { delta: 'done' } },
      { name: 'result', data: {
        runId: 'run-1',
        sessionId: 'session-1',
        status: 'ok',
        reply: 'done',
        durationMs: 10,
      } },
    ]))

    const started: string[] = []
    const deltas: string[] = []
    const events: unknown[] = []
    const result = await api.runAgentStream('read', undefined, undefined, {
      onStart: ({ runId }) => started.push(runId),
      onDelta: (delta) => deltas.push(delta),
      onToolEvent: (event) => events.push(event),
    })

    expect(started).toEqual(['run-1'])
    expect(deltas).toEqual(['done'])
    expect(events).toEqual([expect.objectContaining({ type: 'step_start', stepId: 'step-1' })])
    expect(result).toMatchObject({ runId: 'run-1', status: 'ok', reply: 'done' })
  })

  it('rejects a stream whose result run id differs from its start metadata', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const api = await loadRunApi()
    fetchMock.mockResolvedValueOnce(streamResponse([
      { name: 'start', data: { ok: true, runId: 'run-start' } },
      { name: 'result', data: {
        runId: 'run-other',
        sessionId: 'session-1',
        status: 'ok',
        reply: 'wrong run',
        durationMs: 1,
      } },
    ]))

    await expect(api.runAgentStream('read', undefined, undefined, {
      onDelta: () => undefined,
    })).rejects.toThrow('result run id does not match start metadata')
  })

  it('sends a bounded runtime control event to the run-specific endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const api = await loadRunApi()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      runId: 'run/a',
      outcome: { kind: 'accepted', event: { id: 'event-1' } },
      summary: null,
    }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    }))

    const outcome = await api.sendRuntimeControlEvent('run/a', 'interrupt_requested', 'user stop')

    expect(outcome).toMatchObject({ kind: 'accepted' })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:43127/runs/run%2Fa/events',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ type: 'interrupt_requested', reason: 'user stop' }),
      }),
    )
  })

  it('sends a structured runtime task event to the same run-specific endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const api = await loadRunApi()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      runId: 'run-1',
      outcome: { kind: 'accepted', event: { id: 'event-1' } },
      summary: null,
    }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    }))

    const outcome = await api.sendRuntimeTaskEvent('run-1', {
      type: 'user_message',
      text: 'add a verification step',
      taskBookPatch: { id: 'patch-1' },
      dedupKey: 'user-update-1',
    })

    expect(outcome).toMatchObject({ kind: 'accepted' })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:43127/runs/run-1/events',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          type: 'user_message',
          text: 'add a verification step',
          taskBookPatch: { id: 'patch-1' },
          dedupKey: 'user-update-1',
        }),
      }),
    )
  })
})
