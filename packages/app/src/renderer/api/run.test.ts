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
  const [run, checkpoints] = await Promise.all([import('./run.js'), import('./run-checkpoints.js')])
  return { ...run, ...checkpoints }
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
      { name: 'replace', data: { text: 'done!' } },
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
    const replacements: string[] = []
    const events: unknown[] = []
    const result = await api.runAgentStream('read', undefined, undefined, {
      onStart: ({ runId }) => started.push(runId),
      onDelta: (delta) => deltas.push(delta),
      onReplace: (text) => replacements.push(text),
      onToolEvent: (event) => events.push(event),
    })

    expect(started).toEqual(['run-1'])
    expect(deltas).toEqual(['done'])
    expect(replacements).toEqual(['done!'])
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

  it('resumes a checkpoint through the shared SSE consumer and encoded endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const api = await loadRunApi()
    fetchMock
      .mockResolvedValueOnce(streamResponse([
        { name: 'start', data: { ok: true, runId: 'resume-run-1' } },
        { name: 'approval_request', data: {
          id: 'approval-1',
          action: 'write',
          permissionMode: 'research',
          boundary: 'inside',
          source: 'agent',
        } },
        { name: 'verification_start', data: { type: 'verification_start' } },
        { name: 'result', data: {
          runId: 'resume-run-1',
          sessionId: 'session-1',
          status: 'ok',
          reply: 'continued',
          durationMs: 12,
        } },
      ]))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const started: string[] = []
    const events: unknown[] = []

    const result = await api.resumeRunCheckpointStream('checkpoint/a', {
      text: '继续',
      reason: 'user resumed',
      permissionMode: 'full',
      requestKey: 'stable-recovery-key',
      continuationDirective: 'answer',
    }, {
      onStart: ({ runId }) => started.push(runId),
      onDelta: () => undefined,
      onToolEvent: (event) => events.push(event),
      onApprovalRequest: (request) => request.id === 'approval-1',
    })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:43127/run-checkpoints/checkpoint%2Fa/resume/stream',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          text: '继续',
          reason: 'user resumed',
          permissionMode: 'full',
          requestKey: 'stable-recovery-key',
          continuationDirective: 'answer',
        }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:43127/approvals/approval-1',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ approved: true }) }),
    )
    expect(started).toEqual(['resume-run-1'])
    expect(events).toEqual([{ type: 'verification_start' }])
    expect(result).toMatchObject({ runId: 'resume-run-1', sessionId: 'session-1', status: 'ok' })
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

  it('returns a structured runtime-event rejection instead of hiding it behind HTTP 409', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const api = await loadRunApi()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      runId: 'run-1',
      outcome: {
        kind: 'rejected',
        reason: 'capacity',
        message: 'Runtime event queue reached its limit.',
      },
      summary: null,
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(api.sendRuntimeTaskEvent('run-1', {
      type: 'user_message',
      text: 'keep this input visible',
    })).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'capacity',
    })
  })
})
