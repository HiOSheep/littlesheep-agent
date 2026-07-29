import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeEventIngressOutcome } from '@littlesheep/types'
import { createRunActions, type RunActionContext } from './run-actions'


const apiMocks = vi.hoisted(() => ({
  runAgentStream: vi.fn(),
  sendRuntimeControlEvent: vi.fn(),
  sendRuntimeTaskEvent: vi.fn(),
}))


vi.mock('../api', () => apiMocks)


describe('run actions active-run updates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('queues a running user update without starting a second run', async () => {
    apiMocks.sendRuntimeTaskEvent.mockResolvedValue(outcome('accepted'))
    const fixture = contextFixture('add verification', 'run-1')

    await createRunActions(fixture.context).send()

    expect(apiMocks.runAgentStream).not.toHaveBeenCalled()
    expect(apiMocks.sendRuntimeTaskEvent).toHaveBeenCalledWith('run-1', expect.objectContaining({
      type: 'user_message',
      text: 'add verification',
      id: expect.any(String),
      dedupKey: expect.any(String),
    }))
    expect(fixture.input()).toBe('')
    expect(fixture.notices.at(-1)).toMatchObject({ tone: 'success' })
  })

  it('preserves input when the active queue rejects the update', async () => {
    apiMocks.sendRuntimeTaskEvent.mockResolvedValue(rejected('capacity'))
    const fixture = contextFixture('do not lose this', 'run-1')

    await createRunActions(fixture.context).send()

    expect(fixture.input()).toBe('do not lose this')
    expect(fixture.notices.at(-1)).toMatchObject({
      tone: 'warning',
      text: expect.stringContaining('队列已满'),
    })
  })

  it('reuses the same event identity after an uncertain transport failure', async () => {
    apiMocks.sendRuntimeTaskEvent
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(outcome('duplicate'))
    const fixture = contextFixture('retry safely', 'run-1')
    const actions = createRunActions(fixture.context)

    await actions.send()
    await actions.send()

    const firstRequest = apiMocks.sendRuntimeTaskEvent.mock.calls[0]?.[1]
    const secondRequest = apiMocks.sendRuntimeTaskEvent.mock.calls[1]?.[1]
    expect(firstRequest).toMatchObject({ id: expect.any(String), dedupKey: expect.any(String) })
    expect(secondRequest).toMatchObject({
      id: firstRequest?.id,
      dedupKey: firstRequest?.dedupKey,
    })
    expect(fixture.input()).toBe('')
  })

  it('keeps the update visible while the run identity is still starting', async () => {
    const fixture = contextFixture('wait for startup', null)

    await createRunActions(fixture.context).send()

    expect(apiMocks.sendRuntimeTaskEvent).not.toHaveBeenCalled()
    expect(fixture.input()).toBe('wait for startup')
    expect(fixture.notices.at(-1)?.text).toContain('仍在启动')
  })
})


function contextFixture(initialInput: string, runId: string | null) {
  let input = initialInput
  const notices: Array<{ tone: string; text: string } | null> = []
  const context = {
    abortRef: { current: null },
    activeRunIdRef: { current: runId },
    activeApprovalScopeKey: () => 'draft',
    appMountedRef: { current: true },
    approvalGrantsRef: { current: {} },
    attachments: [],
    currentSession: 'session-1',
    input: initialInput,
    liveToolStepRef: { current: new Map() },
    loading: true,
    permissionMode: 'research',
    pendingRuntimeMessageRef: { current: null },
    publishRuntimeEventNotice: (notice: { tone: string; text: string } | null) => notices.push(notice),
    refreshProjects: vi.fn(),
    refreshSessions: vi.fn(),
    requestApprovalForScope: vi.fn(),
    runtime: null,
    sessionOwnership: { scope: 'standalone' },
    setActivityNow: vi.fn(),
    setAttachments: vi.fn(),
    setContextUsageSnapshot: vi.fn(),
    setCurrentSession: vi.fn(),
    setInput: vi.fn((next: string | ((current: string) => string)) => {
      input = typeof next === 'function' ? next(input) : next
    }),
    setLoading: vi.fn(),
    setMessages: vi.fn(),
    setWorkspaceArtifactVersion: vi.fn(),
    settleApprovalPrompt: vi.fn(),
    stopRequestedRunIdRef: { current: null },
  } as unknown as RunActionContext
  return { context, input: () => input, notices }
}


function outcome(kind: 'accepted' | 'duplicate'): RuntimeEventIngressOutcome {
  return {
    kind,
    event: {
      version: 1,
      id: `event-${kind}`,
      runId: 'run-1',
      sessionId: 'session-1' as never,
      sequence: 1,
      type: 'user_message',
      source: 'app',
      status: 'queued',
      receivedAt: '2026-07-29T00:00:00.000Z',
      payload: { text: 'update' },
    },
  }
}


function rejected(reason: Extract<RuntimeEventIngressOutcome, { kind: 'rejected' }>['reason']): RuntimeEventIngressOutcome {
  return { kind: 'rejected', reason, message: `rejected: ${reason}` }
}
