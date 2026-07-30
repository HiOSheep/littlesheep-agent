import { afterEach, describe, expect, it, vi } from 'vitest'
import { asSessionId, type RuntimeActiveRunSnapshot } from '@littlesheep/types'

async function loadApi() {
  vi.resetModules()
  vi.stubGlobal('window', { littlesheep: { apiBase: 'http://127.0.0.1:43127' } })
  return import('./application-lifecycle.js')
}

function activeRun(): RuntimeActiveRunSnapshot {
  return {
    runId: 'run/one',
    sessionId: asSessionId('session-1'),
    origin: 'app',
    startedAt: '2026-07-29T01:00:00.000Z',
    updatedAt: '2026-07-29T01:00:01.000Z',
    phase: 'executing',
    controlStatus: 'running',
    totalSteps: 2,
    completedSteps: 1,
    activeSteps: [],
    activeToolCount: 0,
  }
}

describe('renderer application lifecycle API', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('lists active runs with the caller abort signal', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const api = await loadApi()
    const controller = new AbortController()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ runs: [activeRun()] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(api.listActiveRuns(controller.signal)).resolves.toEqual([activeRun()])
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:43127/application/active-runs',
      { signal: controller.signal },
    )
  })

  it('streams active run snapshots and releases the reader after completion', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const api = await loadApi()
    const frame = `event: active_runs\ndata: ${JSON.stringify({ runs: [activeRun()] })}\n\n`
    const cancel = vi.fn(async () => undefined)
    let consumed = false
    const reader = {
      read: vi.fn(async () => {
        if (consumed) return { done: true, value: undefined }
        consumed = true
        return { done: false, value: new TextEncoder().encode(frame) }
      }),
      cancel,
    }
    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response)
    const observed: RuntimeActiveRunSnapshot[][] = []

    await api.subscribeActiveRuns(new AbortController().signal, (runs) => observed.push(runs))

    expect(observed).toEqual([[activeRun()]])
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:43127/application/active-runs/stream',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('encodes the run id and preserves structured control rejections', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const api = await loadApi()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      outcome: {
        kind: 'rejected',
        action: 'pause',
        reason: 'action-conflict',
        message: 'already stopping',
      },
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(api.controlActiveRun('run/one', 'pause', 'settings')).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'action-conflict',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:43127/application/active-runs/run%2Fone/control',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'pause', reason: 'settings' }),
      }),
    )
  })

  it('surfaces unexpected server failures', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const api = await loadApi()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'runtime unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(api.controlActiveRun('run-1', 'interrupt')).rejects.toThrow('runtime unavailable')
  })
})
